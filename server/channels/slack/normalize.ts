/** Inbound Socket Mode event normalization for Slack.
 * Protocol facts ported from xmanrui/dsh-im (MIT).
 *
 * 处理范围（渠道卡事实）：
 * - `app_mention`：群内 @机器人，kind=group、mention=true；
 * - `message` 且 channel_type=im：私聊（channel 以 D 开头等价）；
 * - channel/group 内的非 mention `message` 一律忽略；
 * - 过滤 bot_id / app_id 与 file_share 之外的 subtype（message_changed 等）；
 * - thread_ts → threadId；files[].url_private_download 走注入的下载器。 */
import type {
  ChannelId,
  NormalizedMedia,
  NormalizedMessage,
} from "../../../shared/model.ts";
import {
  slackEventPayloadSchema,
  type SlackFile,
} from "./schema.ts";

export interface NormalizeDeps {
  botUserId: string;
  botId?: string;
  connectionId: string;
  /** 下载 url_private_download 到 ctx.mediaDir，返回本地路径。 */
  downloadFile: (url: string, file: SlackFile) => Promise<string>;
  logWarn?: (message: string) => void;
}

export interface NormalizedSlackEvent {
  message: NormalizedMessage;
  /** 去重键：event_id（缺失时退回 ts）。 */
  eventId: string;
  /** thread_ts 存在且不等于自身 ts 时给出，由适配器拉取父消息。 */
  threadParentTs?: string;
}

/** Slack 文本实体解码：&amp; &lt; &gt;（单遍替换，&amp;lt; 不会二次解码成 <）。 */
export function decodeSlackText(value: string): string {
  return value.replace(/&(amp|lt|gt);/g, (entity) =>
    entity === "&amp;" ? "&" : entity === "&lt;" ? "<" : ">",
  );
}

/** 去掉 <@BOTID>（含 <@BOTID|fallback> 形式）的提及标记。 */
export function stripBotMention(value: string, botUserId: string, botId?: string): string {
  const ids = [botUserId, botId].filter((id): id is string => Boolean(id));
  if (ids.length === 0) return value.trim();
  const pattern = ids.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return value.replace(new RegExp(`<@(?:${pattern})(?:\\|[^>]*)?>`, "gi"), "").trim();
}

export function hasBotMention(value: string, botUserId: string, botId?: string): boolean {
  const ids = [botUserId, botId].filter((id): id is string => Boolean(id));
  if (ids.length === 0) return false;
  const pattern = ids.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`<@(?:${pattern})(?:\\|[^>]*)?>`, "i").test(value);
}

/** /^[/!][A-Za-z][A-Za-z0-9_-]{0,63}(\s|$)/ —— 与参考实现一致的命令形态。 */
export function isCommandLike(text: string): boolean {
  return /^[/!][A-Za-z][A-Za-z0-9_-]{0,63}(\s|$)/.test(text.trim());
}

function eventTimestamp(eventTs: string | undefined, eventTime: number | undefined): number {
  const ts = eventTs ? Number.parseFloat(eventTs) : Number.NaN;
  if (Number.isFinite(ts) && ts > 0) return Math.round(ts * 1000);
  if (eventTime !== undefined && Number.isFinite(eventTime) && eventTime > 0) {
    return Math.round(eventTime * 1000);
  }
  return Date.now();
}

async function filesToMedia(
  files: SlackFile[],
  deps: NormalizeDeps,
): Promise<NormalizedMedia[]> {
  const media: NormalizedMedia[] = [];
  for (const file of files) {
    const url = file.url_private_download ?? file.url_private;
    if (!url) continue; // 无可下载地址的附件跳过
    const mime = file.mimetype;
    try {
      const path = await deps.downloadFile(url, file);
      media.push({
        kind: mime?.startsWith("image/") ? "image" : "file",
        path,
        ...(mime ? { mime } : {}),
        ...(file.name || file.title ? { name: file.name ?? file.title } : {}),
      });
    } catch (error) {
      deps.logWarn?.(`Slack 附件下载失败（${(error as Error).message}），已跳过该附件`);
    }
  }
  return media;
}

export async function normalizeEvent(
  payload: unknown,
  deps: NormalizeDeps,
): Promise<NormalizedSlackEvent | null> {
  const parsed = slackEventPayloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  const { event } = parsed.data;

  const channel = event.channel;
  const user = event.user;
  const ts = event.ts;
  if (!channel || !user || !ts) return null;

  const direct =
    event.type === "message" &&
    (event.channel_type === "im" ||
      (event.channel_type === undefined && channel.startsWith("D")));
  const rawText = decodeSlackText(event.text ?? "");
  const mentioned =
    event.type === "app_mention" ||
    (event.type === "message" && !direct && hasBotMention(rawText, deps.botUserId, deps.botId));
  const inThread =
    event.type === "message" && !direct && Boolean(event.thread_ts);
  if (!direct && !mentioned && !inThread) return null; // channel/group 内非 mention 且非 thread 忽略

  // 机器人自身消息、其他应用（工作流）消息、file_share 之外的子类型均为噪音
  if (event.bot_id || event.app_id) return null;
  if (user === deps.botUserId || (deps.botId && user === deps.botId)) return null;
  if (event.subtype !== undefined && event.subtype !== "file_share") return null;

  const text = stripBotMention(rawText, deps.botUserId, deps.botId);
  const kind = direct || channel.startsWith("D") ? "dm" : "group";
  // 顶层消息（私聊或群聊/频道）若尚未处于 thread 中，则以自身 ts 作为 thread 根，保证回复进 thread 且会话独立
  const threadTs = event.thread_ts ?? ts;
  const threadParentTs =
    event.thread_ts && event.thread_ts !== ts ? event.thread_ts : undefined;

  const media = event.files ? await filesToMedia(event.files, deps) : [];
  if (!text && media.length === 0) return null; // 无文本无媒体的噪音不投递

  const replyToBot =
    Boolean(deps.botUserId) &&
    Boolean(event.parent_user_id) &&
    event.parent_user_id === deps.botUserId;

  const message: NormalizedMessage = {
    channel: "slack" satisfies ChannelId,
    connectionId: deps.connectionId,
    kind,
    chatId: channel,
    ...(threadTs ? { threadId: threadTs } : {}),
    senderId: user,
    messageId: ts,
    timestamp: eventTimestamp(event.ts, parsed.data.event_time),
    ...(text ? { text } : {}),
    ...(media.length > 0 ? { media } : {}),
    trigger: {
      mention: direct || mentioned,
      replyToBot,
      command: isCommandLike(text),
    },
  };
  return {
    message,
    eventId: parsed.data.event_id ?? ts,
    ...(threadParentTs ? { threadParentTs } : {}),
  };
}
