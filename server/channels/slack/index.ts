/** Slack adapter: Socket Mode inbound, Web API outbound.
 * Protocol facts ported from xmanrui/dsh-im (MIT).
 *
 * - 启动：校验 xoxb-/xapp- 凭据 → auth.test 身份核对（team_id/user_id）→
 *   apps.connections.open 获取 wss 地址 → 裸 ws 连接等待 hello；瞬时错误走
 *   ctx.onError + [1,3,5,10,30]s 退避重连，直到 ctx.signal abort。
 * - envelope：type=events_api 处理 payload（event_callback），interactive/
 *   slash_commands 仅 ACK，disconnect → close(4000) 触发重连。
 * - 发送：chat.postMessage（mrkdwn 渲染、fence-aware 分块 11000、markdown
 *   被拒时回退纯文本）；进度 chat.startStream/appendStream/stopStream，
 *   不可用时回退占位消息 + chat.update；上传走三步 API。 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { CHANNEL_SPECS } from "../../../shared/channels.ts";
import type { Connection } from "../../../shared/config.ts";
import { UserFacingError } from "../../../shared/errors.ts";
import type {
  ChannelCapabilities,
  ChannelId,
  NormalizedMessage,
  OutboundMedia,
  OutboundText,
  SendResult,
} from "../../../shared/model.ts";
import { sleep, WriteChain } from "../../files.ts";
import { defaultConfigure, requireFields } from "../configure.ts";
import type {
  AdapterContext,
  ChannelAdapter,
  ChannelDefinition,
  ConfiguredFields,
} from "../types.ts";
import {
  createFileDownloader,
  createRestClient,
  createUploader,
  SlackApiError,
  socketEventData,
  validateHttpsFileUrl,
  validateSocketUrl,
  type SlackDeps,
  type SlackSocketLike,
} from "./api.ts";
import { splitMrkdwnChunks, toMrkdwn, toPlain } from "./markdown.ts";
import { decodeSlackText, normalizeEvent } from "./normalize.ts";
import {
  slackEventPayloadSchema,
  slackHistorySchema,
  slackSocketEnvelopeSchema,
  type SlackRestResponse,
} from "./schema.ts";
import {
  ACTIVE_THREAD_CAP,
  loadSlackState,
  OWN_MESSAGE_CAP,
  saveSlackState,
  SEEN_EVENT_CAP,
  type SlackState,
} from "./state.ts";

export type SlackConnection = Extract<Connection, { channel: "slack" }>;

const RECONNECT_DELAYS_MS = [1_000, 3_000, 5_000, 10_000, 30_000];
const HELLO_TIMEOUT_MS = 20_000;
/** chat.postMessage 上限 38k；chunk 11000 留足余量并便于进度原位替换。 */
const MAX_CHUNK_CHARS = 11_000;
const STREAM_PLACEHOLDER = "…";
/** Token 失效类 provider code → 可执行的中文提示。 */
const BOT_TOKEN_ERROR_CODES = ["invalid_auth", "not_authed", "token_revoked", "account_inactive"];
const APP_TOKEN_ERROR_CODES = ["invalid_auth", "not_authed", "token_revoked", "account_inactive"];
/** chat.*Stream 在该渠道/套餐不可用的 provider code → 回退 chat.update。 */
const STREAM_UNAVAILABLE_CODES = [
  "method_not_supported_for_channel_type",
  "channel_type_not_supported",
  "deprecated_endpoint",
  "missing_scope",
  "feature_not_enabled",
  "not_allowed",
  "invalid_thread_ts",
  "missing_argument",
  "invalid_arguments",
  "missing_recipient_team_id",
  "missing_recipient_user_id",
];
/** markdown 渲染被 Slack 拒绝的 provider code → 重发纯文本。 */
const MARKDOWN_REJECTION_CODES = ["invalid_blocks", "invalid_blocks_format", "invalid_markdown"];

const SLACK_CAPABILITIES: ChannelCapabilities = {
  progress: "edit",
  markdown: "custom",
  uploadImage: true,
  uploadFile: true,
  reactions: false,
  typing: false,
  maxChunkChars: MAX_CHUNK_CHARS,
  threads: true,
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

interface ActiveStream {
  channel: string;
  threadId?: string;
  /** startStream 不可用：append/finish 走 chat.update。 */
  fallback: boolean;
  /** 已通过 appendStream 发送的前缀（增量与 finish 校验用）。 */
  appended: string;
  /** append 出错后置位：finish 直接用 chat.update 覆盖最终文本。 */
  broken: boolean;
}

export class SlackAdapter implements ChannelAdapter {
  readonly channel: ChannelId = "slack";
  readonly capabilities = SLACK_CAPABILITIES;
  readonly remembersOwnMessages = true;

  readonly #ctx: AdapterContext<SlackConnection>;
  readonly #deps: SlackDeps;
  readonly #abort = new AbortController();
  readonly #signal: AbortSignal;
  readonly #stateChain = new WriteChain();
  #state: SlackState = { seenEventIds: [], ownMessageTs: [], activeThreads: [] };
  #generation = 0;
  #stopped = false;
  #started = false;
  #socket: SlackSocketLike | null = null;
  #appId: string | null = null;
  #ready = deferred<void>();
  #stoppedGate = deferred<void>();
  #teamId = "";
  #botUserId = "";
  #botId = "";
  #streams = new Map<string, ActiveStream>();

  constructor(ctx: AdapterContext<SlackConnection>, deps: SlackDeps) {
    this.#ctx = ctx;
    this.#deps = deps;
    this.#signal = AbortSignal.any([ctx.signal, this.#abort.signal]);
    this.#teamId = ctx.config.teamId;
    this.#botUserId = ctx.config.botUserId;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    try {
      await this.#start();
    } catch (error) {
      this.#started = false;
      throw error;
    }
  }

  async #start(): Promise<void> {
    // 凭据格式校验（不触网，给可执行的中文提示）
    const botToken = (this.#ctx.secrets.botToken ?? "").trim();
    const appToken = (this.#ctx.secrets.appToken ?? "").trim();
    if (!botToken) {
      throw new UserFacingError(
        "Slack Bot Token 缺失，请在连接设置中填写以 xoxb- 开头的 Bot User OAuth Token。",
      );
    }
    if (!appToken) {
      throw new UserFacingError(
        "Slack App Token 缺失，请在连接设置中填写以 xapp- 开头的 App-Level Token。",
      );
    }
    if (!botToken.startsWith("xoxb-")) {
      throw new UserFacingError(
        "Slack Bot Token 应以 xoxb- 开头，请到应用后台 OAuth & Permissions 页面复制 Bot User OAuth Token。",
      );
    }
    if (!appToken.startsWith("xapp-")) {
      throw new UserFacingError(
        "Slack App Token 应以 xapp- 开头，请到应用后台 Basic Information → App-Level Tokens 生成（需勾选 connections:write）。",
      );
    }

    this.#state = await loadSlackState(this.#statePath());

    // auth.test 核对 team_id/user_id；瞬时错误退避重试
    await this.#verifyIdentity();

    void this.#connectLoop().catch(() => {});
    await this.#ready.promise;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#generation += 1;
    this.#abort.abort(new Error("Slack 适配器已停止"));
    this.#closeSocket();
    this.#streams.clear();
    this.#stoppedGate.resolve();
    this.#ready.reject(new Error("Slack 适配器已停止"));
    // 停止前把 seen/own 状态落盘，保证重启后去重仍生效
    try {
      await this.#stateChain.run(() => saveSlackState(this.#statePath(), this.#state));
    } catch (error) {
      this.#ctx.log("warn", `Slack 停止时状态落盘失败：${(error as Error).message}`);
    }
  }

  async #verifyIdentity(): Promise<void> {
    let attempt = 0;
    for (;;) {
      if (this.#isStopped()) throw new Error("Slack 适配器已停止");
      try {
        const identity = await this.#deps.rest("auth.test", {});
        const teamId = asText(identity.team_id);
        const userId = asText(identity.user_id);
        const botId = asText(identity.bot_id) ?? "";
        if (!teamId || !userId) {
          throw new UserFacingError(
            "Slack auth.test 没有返回 team_id/user_id，请确认填写的是 Bot User OAuth Token（xoxb-）。",
          );
        }
        if (
          this.#ctx.config.teamId === "__pending__" ||
          this.#ctx.config.botUserId === "__pending__"
        ) {
          this.#teamId = teamId;
          this.#botUserId = userId;
          this.#botId = botId;
          await this.#ctx.updateConfig?.({ teamId, botUserId: userId });
          return;
        }
        if (teamId !== this.#ctx.config.teamId || userId !== this.#ctx.config.botUserId) {
          throw new UserFacingError(
            `Slack 机器人身份与连接配置不一致：auth.test 返回 team_id=${teamId} user_id=${userId}，` +
              `连接配置为 teamId=${this.#ctx.config.teamId} botUserId=${this.#ctx.config.botUserId}，请用该 Token 重新创建连接。`,
          );
        }
        this.#teamId = teamId;
        this.#botUserId = userId;
        this.#botId = botId;
        return;
      } catch (error) {
        if (this.#isStopped() || error instanceof UserFacingError) throw error;
        if (error instanceof SlackApiError && BOT_TOKEN_ERROR_CODES.includes(error.providerCode)) {
          throw new UserFacingError(
            "Slack Bot Token 无效或已被撤销，请到应用后台重新生成 Bot User OAuth Token 并更新连接。",
          );
        }
        this.#ctx.onError(asError(error));
        await this.#backoffSleep(attempt);
        attempt += 1;
      }
    }
  }

  async #connectLoop(): Promise<void> {
    let attempt = 0;
    while (!this.#isStopped()) {
      const generation = ++this.#generation;
      const ready = deferred<void>();
      const closed = deferred<void>();
      let socket: SlackSocketLike | null = null;
      try {
        const connection = await this.#deps.rest("apps.connections.open", {});
        try {
          socket = this.#deps.openSocket(validateSocketUrl(connection.url));
        } catch (error) {
          throw new UserFacingError(
            "Slack 无法建立 Socket Mode 连接，请确认应用已开启 Socket Mode、App Token 以 xapp- 开头且具有 connections:write 权限。",
            { cause: error },
          );
        }
        this.#socket = socket;
        const hello = { seen: false };
        this.#wireSocket(socket, generation, ready, closed, {
          markHello: () => {
            hello.seen = true;
          },
          hasHello: () => hello.seen,
        });

        const timeout = setTimeout(
          () => ready.reject(new Error("Slack Socket Mode 连接超时：未在限定时间内收到 hello")),
          HELLO_TIMEOUT_MS,
        );
        timeout.unref?.();
        try {
          await ready.promise;
        } finally {
          clearTimeout(timeout);
        }

        attempt = 0;
        this.#ready.resolve();
        await Promise.race([closed.promise, this.#stoppedGate.promise]);
        if (this.#isStopped()) return;
        throw new Error("Slack Socket Mode 连接已断开，正在按退避重连");
      } catch (error) {
        if (socket !== null) this.#closeSpecific(socket);
        if (this.#isStopped()) return;
        if (error instanceof SlackApiError && APP_TOKEN_ERROR_CODES.includes(error.providerCode)) {
          // App Token 失效不是瞬时错误：直接终止并让 Manager 展示原因
          const mapped = new UserFacingError(
            "Slack App Token 无效或已被撤销，请重新生成 App-Level Token（xapp-，需 connections:write）并更新连接。",
            { cause: error },
          );
          this.#ctx.onError(mapped);
          this.#ready.reject(mapped);
          return;
        }
        if (error instanceof UserFacingError) {
          this.#ctx.onError(error);
          this.#ready.reject(error);
          return;
        }
        this.#ctx.onError(asError(error));
        try {
          await this.#backoffSleep(attempt);
          attempt += 1;
        } catch {
          return;
        }
      }
    }
  }

  #wireSocket(
    socket: SlackSocketLike,
    generation: number,
    ready: Deferred<void>,
    closed: Deferred<void>,
    lifecycle: { markHello: () => void; hasHello: () => boolean },
  ): void {
    socket.addEventListener("message", (event) => {
      if (generation !== this.#generation || this.#stopped) return;
      const raw = socketEventData(event);
      if (raw === null) return;
      let envelopeRaw: unknown;
      try {
        envelopeRaw = JSON.parse(raw);
      } catch {
        this.#ctx.log("warn", "Slack Socket Mode 收到无法解析的 JSON 消息，已忽略");
        return;
      }
      const parsed = slackSocketEnvelopeSchema.safeParse(envelopeRaw);
      if (!parsed.success) return;
      const envelope = parsed.data;

      if (envelope.type === "hello") {
        this.#appId = envelope.connection_info?.app_id ?? null;
        lifecycle.markHello();
        this.#ctx.onReady?.();
        ready.resolve();
        return;
      }
      // events_api / interactive / slash_commands 都必须 ACK
      if (envelope.envelope_id !== undefined) {
        this.#safeSend(socket, JSON.stringify({ envelope_id: envelope.envelope_id }));
      }
      if (envelope.type === "disconnect") {
        // Slack 要求客户端主动断开并以退避重连
        try {
          socket.close(4000, "Slack disconnect");
        } catch {
          // 已关闭时忽略
        }
        return;
      }
      if (envelope.type === "events_api") {
        void this.#handleEnvelope(envelope.payload).catch((error: unknown) => {
          this.#ctx.onError(asError(error));
        });
      }
    });

    socket.addEventListener("close", (event) => {
      if (generation !== this.#generation) return;
      if (this.#socket === socket) this.#socket = null;
      if (!lifecycle.hasHello()) {
        ready.reject(
          new Error(`Slack Socket Mode 连接在就绪前关闭（code ${event.code ?? "unknown"}）`),
        );
      }
      closed.resolve();
    });

    socket.addEventListener("error", (event) => {
      if (generation !== this.#generation) return;
      const error = asError(event.error ?? new Error("Slack WebSocket 连接错误"));
      if (!lifecycle.hasHello()) ready.reject(error);
      else this.#ctx.onError(error);
    });
  }

  async #handleEnvelope(payload: unknown): Promise<void> {
    const parsed = slackEventPayloadSchema.safeParse(payload);
    if (!parsed.success || parsed.data.type !== "event_callback") return;
    if (
      this.#appId !== null &&
      parsed.data.api_app_id !== undefined &&
      parsed.data.api_app_id !== this.#appId
    ) {
      return;
    }

    const eventId = parsed.data.event_id ?? parsed.data.event.ts ?? "";
    if (!eventId || this.#alreadySeen(eventId)) return;

    const normalized = await normalizeEvent(parsed.data, {
      botUserId: this.#botUserId,
      ...(this.#botId ? { botId: this.#botId } : {}),
      connectionId: this.#ctx.connectionId,
      downloadFile: (url, file) => this.#deps.downloadFile(url, file),
      logWarn: (message) => this.#ctx.log("warn", message),
    });
    if (!normalized) return;

    const message = normalized.message;
    // Slack 对频道内含 @bot 的消息可能同时推送 app_mention 与 message 两个不同 event_id 的事件，按消息坐标二次去重
    const messageKey = `msg:${message.chatId}:${message.messageId}`;
    if (eventId !== message.messageId && this.#alreadySeen(messageKey)) return;

    if (normalized.threadParentTs) {
      await this.#applyThreadParent(message, normalized.threadParentTs);
    }
    if (
      message.threadId &&
      (message.trigger.mention || message.trigger.replyToBot)
    ) {
      this.#rememberThread(message.chatId, message.threadId);
    }
    this.#ctx.onMessage(message);
  }

  async #applyThreadParent(message: NormalizedMessage, parentTs: string): Promise<void> {
    const activeThread = this.#isActiveThread(message.chatId, parentTs);
    let parent: { ts?: string; user?: string; bot_id?: string; text?: string } | undefined;
    try {
      const history = slackHistorySchema.parse(
        await this.#deps.rest("conversations.history", {
          channel: message.chatId,
          oldest: parentTs,
          latest: parentTs,
          inclusive: true,
          limit: 1,
        }),
      );
      parent = (history.messages ?? []).find((entry) => entry.ts === parentTs);
    } catch {
      parent = undefined; // 缺少 scope 等情况：退回本地记忆判断
    }
    if (parent) {
      const text = parent.text ? decodeSlackText(parent.text) : "";
      message.replyTo = {
        id: parentTs,
        ...(text ? { text } : {}),
        ...(parent.user ? { sender: parent.user } : {}),
      };
      message.trigger.replyToBot =
        Boolean(message.trigger.replyToBot) ||
        activeThread ||
        this.isOwnMessage(parentTs) ||
        parent.user === this.#botUserId ||
        Boolean(parent.bot_id);
    } else {
      message.trigger.replyToBot =
        Boolean(message.trigger.replyToBot) ||
        activeThread ||
        this.isOwnMessage(parentTs);
    }
  }

  async sendText(outbound: OutboundText): Promise<SendResult> {
    const threadTs = outbound.threadId ?? outbound.replyToId;
    const source = outbound.text ?? "";
    if (!source.trim()) return {};
    const chunks = splitMrkdwnChunks(source, MAX_CHUNK_CHARS);
    let messageId: string | undefined;
    for (const chunk of chunks) {
      const id = await this.#postMessage(outbound.chatId, threadTs, chunk);
      if (id) {
        messageId ??= id;
        this.#rememberOwn(id);
      }
    }
    if (threadTs) this.#rememberThread(outbound.chatId, threadTs);
    return messageId ? { messageId } : {};
  }

  async #postMessage(
    chatId: string,
    threadTs: string | undefined,
    rawText: string,
  ): Promise<string | undefined> {
    const mrkdwnText = toMrkdwn(rawText);
    const base = {
      channel: chatId,
      mrkdwn: true,
      link_names: false,
      unfurl_links: false,
      unfurl_media: false,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    };
    let result: SlackRestResponse;
    try {
      result = await this.#deps.rest("chat.postMessage", {
        ...base,
        text: mrkdwnText,
        blocks: [{ type: "markdown", text: rawText }],
      });
    } catch (error) {
      if (error instanceof SlackApiError && MARKDOWN_REJECTION_CODES.includes(error.providerCode)) {
        // markdown 被拒：按纯文本原样重发这一块
        result = await this.#deps.rest("chat.postMessage", { ...base, text: toPlain(rawText) });
      } else {
        throw this.#sendError(error);
      }
    }
    if (threadTs) this.#rememberThread(chatId, threadTs);
    const ts = asText(result.ts);
    if (ts) return ts;
    const message = result.message;
    if (message && typeof message === "object" && "ts" in message) return asText(message.ts);
    return undefined;
  }

  async sendMedia(outbound: OutboundMedia): Promise<SendResult> {
    const name = outbound.name?.trim() || basename(outbound.path);
    const bytes = new Uint8Array(await readFile(outbound.path));
    let ticket: SlackRestResponse;
    try {
      ticket = await this.#deps.rest("files.getUploadURLExternal", {
        filename: name,
        length: bytes.byteLength,
      });
    } catch (error) {
      throw this.#sendError(error);
    }
    const uploadUrl = asText(ticket.upload_url);
    const fileId = asText(ticket.file_id);
    if (!uploadUrl || !fileId) {
      throw new UserFacingError("Slack 文件上传响应缺少 upload_url/file_id，已取消上传。");
    }
    validateHttpsFileUrl(uploadUrl, "文件上传");

    const form = new FormData();
    form.append(
      "file",
      new Blob([bytes], { type: outbound.mime ?? "application/octet-stream" }),
      name,
    );
    const uploaded = await this.#deps.uploadBytes(uploadUrl, form);
    if (uploaded.status !== 200) {
      throw new UserFacingError(`Slack 文件上传失败（HTTP ${uploaded.status}），请稍后重试。`);
    }
    try {
      await this.#deps.rest("files.completeUploadExternal", {
        files: [{ id: fileId, title: name }],
        channel_id: outbound.chatId,
        ...(outbound.threadId ? { thread_ts: outbound.threadId } : {}),
      });
    } catch (error) {
      throw this.#sendError(error);
    }
    if (outbound.caption?.trim()) {
      await this.sendText({ chatId: outbound.chatId, threadId: outbound.threadId, text: outbound.caption });
    }
    return {};
  }

  async editMessage(messageId: string, chatId: string, text: string): Promise<void> {
    await this.#updateMessage(messageId, chatId, text);
  }

  async streamStart(chatId: string, threadId?: string): Promise<{ streamId: string }> {
    if (threadId) this.#rememberThread(chatId, threadId);
    try {
      const started = await this.#deps.rest("chat.startStream", {
        channel: chatId,
        ...(threadId ? { thread_ts: threadId } : {}),
      });
      const ts = asText(started.ts);
      if (!ts) throw new Error("Slack 未返回流式消息 ts");
      this.#streams.set(ts, { channel: chatId, threadId, fallback: false, appended: "", broken: false });
      return { streamId: ts };
    } catch (error) {
      if (
        error instanceof SlackApiError
        && (STREAM_UNAVAILABLE_CODES.includes(error.providerCode)
          || error.providerCode === "transport"
          || error.transient)
      ) {
        // 流式 API 不可用或瞬时故障（网络/5xx）：回退为占位消息 + chat.update
        // （参照 feishu broken 降级），不让投递链路炸掉。
        const placeholderTs = await this.#postMessage(chatId, threadId, STREAM_PLACEHOLDER);
        if (!placeholderTs) throw error;
        this.#rememberOwn(placeholderTs);
        this.#streams.set(placeholderTs, {
          channel: chatId,
          threadId,
          fallback: true,
          appended: "",
          broken: false,
        });
        return { streamId: placeholderTs };
      }
      throw error;
    }
  }

  async streamAppend(streamId: string, text: string): Promise<void> {
    const stream = this.#streams.get(streamId);
    if (!stream) throw new Error("Slack 流式消息不存在或已结束");
    const raw = text ?? "";
    const mrkdwn = toMrkdwn(raw);
    if (stream.fallback || stream.broken) {
      await this.#updateMessage(streamId, stream.channel, raw);
      return;
    }
    if (stream.appended && !mrkdwn.startsWith(stream.appended)) {
      // 文本被收缩/重写：先结束原生流，再直接用 chat.update 原位更新本次文本
      stream.broken = true;
      stream.fallback = true;
      await this.#stopStreamQuiet(streamId, stream.channel);
      await this.#updateMessage(streamId, stream.channel, raw);
      return;
    }
    const delta = mrkdwn.slice(stream.appended.length);
    if (!delta) return;
    try {
      await this.#appendStreamChunks(streamId, stream.channel, delta);
    } catch (error) {
      if (error instanceof SlackApiError) {
        stream.broken = true;
        stream.fallback = true;
        await this.#stopStreamQuiet(streamId, stream.channel);
        await this.#updateMessage(streamId, stream.channel, raw);
        return;
      }
      throw error;
    }
    stream.appended = mrkdwn;
  }

  async streamFinish(streamId: string, text: string): Promise<{ messageId?: string }> {
    const stream = this.#streams.get(streamId);
    if (!stream) throw new Error("Slack 流式消息不存在或已结束");
    this.#streams.delete(streamId);

    const rawSource = (text ?? "").trim() ? (text ?? "") : STREAM_PLACEHOLDER;
    const rawChunks = splitMrkdwnChunks(rawSource, MAX_CHUNK_CHARS);
    const rawFirst = rawChunks[0];
    const first = toMrkdwn(rawFirst);
    const restChunks = rawChunks.slice(1);

    if (stream.fallback || stream.broken || !first.startsWith(stream.appended)) {
      // 流式不可用/中断/前缀不一致：终止流并整体覆写
      if (!stream.fallback) {
        await this.#stopStreamQuiet(streamId, stream.channel);
      }
      await this.#updateMessage(streamId, stream.channel, rawFirst);
    } else {
      // stopStream 的 markdown_text 为最终文本（含未 append 的增量）
      try {
        await this.#deps.rest("chat.stopStream", {
          channel: stream.channel,
          ts: streamId,
          markdown_text: first,
        });
      } catch {
        await this.#stopStreamQuiet(streamId, stream.channel);
        await this.#updateMessage(streamId, stream.channel, rawFirst);
      }
    }
    this.#rememberOwn(streamId);
    if (stream.threadId) this.#rememberThread(stream.channel, stream.threadId);
    for (const chunk of restChunks) {
      const id = await this.#postMessage(stream.channel, stream.threadId, chunk);
      if (id) this.#rememberOwn(id);
    }
    return { messageId: streamId };
  }

  async testConnection(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const identity = await this.#deps.rest("auth.test", {});
      const team = asText(identity.team) ?? asText(identity.team_id) ?? "";
      return { ok: true, detail: team ? `Slack 工作区 ${team} 凭据有效` : "Slack 凭据有效" };
    } catch (error) {
      return {
        ok: false,
        detail:
          error instanceof SlackApiError
            ? error.message
            : "Slack 凭据校验失败，请检查网络后重试。",
      };
    }
  }

  isOwnMessage(messageId: string): boolean {
    return this.#state.ownMessageTs.includes(messageId);
  }

  rememberOwnMessage(messageId: string): void {
    this.#rememberOwn(messageId);
  }

  async #appendStreamChunks(streamId: string, channel: string, delta: string): Promise<void> {
    for (let offset = 0; offset < delta.length; offset += MAX_CHUNK_CHARS) {
      await this.#deps.rest("chat.appendStream", {
        channel,
        ts: streamId,
        markdown_text: delta.slice(offset, offset + MAX_CHUNK_CHARS),
      });
    }
  }

  async #updateMessage(messageId: string, chatId: string, rawText: string): Promise<void> {
    const normalizedRaw = rawText.trim() ? rawText : STREAM_PLACEHOLDER;
    const mrkdwnText = toMrkdwn(normalizedRaw).trim() || STREAM_PLACEHOLDER;
    try {
      await this.#deps.rest("chat.update", {
        channel: chatId,
        ts: messageId,
        text: mrkdwnText,
        blocks: [{ type: "markdown", text: normalizedRaw }],
        link_names: false,
      });
    } catch (error) {
      // 进度刷新常写入相同文本，未变化不算失败
      if (error instanceof SlackApiError && error.providerCode === "message_not_modified") return;
      if (error instanceof SlackApiError && MARKDOWN_REJECTION_CODES.includes(error.providerCode)) {
        try {
          await this.#deps.rest("chat.update", {
            channel: chatId,
            ts: messageId,
            text: toPlain(normalizedRaw).trim() || STREAM_PLACEHOLDER,
            blocks: [],
            link_names: false,
          });
          return;
        } catch (retryError) {
          if (retryError instanceof SlackApiError && retryError.providerCode === "message_not_modified") return;
          throw this.#sendError(retryError);
        }
      }
      throw this.#sendError(error);
    }
  }

  async #stopStreamQuiet(streamId: string, channel: string): Promise<void> {
    try {
      await this.#deps.rest("chat.stopStream", { channel, ts: streamId });
    } catch (error) {
      if (error instanceof SlackApiError && error.providerCode === "message_not_in_streaming_state") {
        return;
      }
      this.#ctx.log("warn", `Slack 终止流式消息失败：${(error as Error).message}`);
    }
  }

  #sendError(error: unknown): UserFacingError {
    if (error instanceof UserFacingError) return error;
    if (error instanceof SlackApiError) {
      if (error.providerCode === "transport" || error.transient) {
        return new UserFacingError("Slack 连接不可用，消息可能未送达，请稍后重试。", { cause: error });
      }
      return new UserFacingError(`Slack 发送失败（${error.providerCode}），请检查机器人权限后重试。`, {
        cause: error,
      });
    }
    return new UserFacingError("Slack 发送失败，请稍后重试。", { cause: error });
  }

  #alreadySeen(eventId: string): boolean {
    if (this.#state.seenEventIds.includes(eventId)) return true;
    this.#state.seenEventIds.push(eventId);
    if (this.#state.seenEventIds.length > SEEN_EVENT_CAP) {
      this.#state.seenEventIds.splice(0, this.#state.seenEventIds.length - SEEN_EVENT_CAP);
    }
    this.#persistState();
    return false;
  }

  #rememberOwn(messageId: string): void {
    if (!messageId || this.#state.ownMessageTs.includes(messageId)) return;
    this.#state.ownMessageTs.push(messageId);
    if (this.#state.ownMessageTs.length > OWN_MESSAGE_CAP) {
      this.#state.ownMessageTs.splice(0, this.#state.ownMessageTs.length - OWN_MESSAGE_CAP);
    }
    this.#persistState();
  }

  #threadKey(chatId: string, threadTs: string): string {
    return `${chatId}:${threadTs}`;
  }

  #isActiveThread(chatId: string, threadTs: string): boolean {
    const list = this.#state.activeThreads ?? [];
    return list.includes(this.#threadKey(chatId, threadTs)) || list.includes(threadTs);
  }

  #rememberThread(chatId: string, threadTs: string): void {
    if (!chatId || !threadTs) return;
    const key = this.#threadKey(chatId, threadTs);
    const list = (this.#state.activeThreads ??= []);
    if (list.includes(key)) return;
    list.push(key);
    if (list.length > ACTIVE_THREAD_CAP) {
      list.splice(0, list.length - ACTIVE_THREAD_CAP);
    }
    this.#persistState();
  }

  #persistState(): void {
    const state = this.#state;
    void this.#stateChain
      .run(() => saveSlackState(this.#statePath(), state))
      .catch((error: unknown) => {
        this.#ctx.log("warn", `Slack 状态文件写入失败：${(error as Error).message}`);
      });
  }

  #statePath(): string {
    return `${this.#ctx.dataDir}/slack-state.json`;
  }

  #isStopped(): boolean {
    return this.#stopped || this.#signal.aborted;
  }

  async #backoffSleep(attempt: number): Promise<void> {
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
    await sleep(delay, this.#signal);
  }

  #safeSend(socket: SlackSocketLike, data: string): void {
    try {
      const state = socket.readyState;
      if (state === undefined || state === 1) socket.send(data);
    } catch (error) {
      this.#ctx.log("warn", `Slack Socket Mode ACK 发送失败：${(error as Error).message}`);
    }
  }

  #closeSocket(): void {
    const socket = this.#socket;
    this.#socket = null;
    if (socket !== null) this.#closeSpecific(socket);
  }

  #closeSpecific(socket: SlackSocketLike): void {
    try {
      socket.close(1000, "插件停止");
    } catch (error) {
      this.#ctx.log("warn", `关闭 Slack Socket Mode 连接失败：${(error as Error).message}`);
    }
  }
}

/** 默认依赖：原生 WebSocket + Web API REST + files.slack.com 下载/上传。 */
export function defaultDeps(ctx: AdapterContext<SlackConnection>): SlackDeps {
  const secret = (key: string): string => (ctx.secrets[key] ?? "").trim();
  return {
    rest: createRestClient({
      botToken: () => secret("botToken"),
      appToken: () => secret("appToken"),
      signal: ctx.signal,
    }),
    openSocket: (url) => new WebSocket(url) as unknown as SlackSocketLike,
    downloadFile: createFileDownloader({
      botToken: () => secret("botToken"),
      mediaDir: ctx.mediaDir,
      signal: ctx.signal,
      maxBytes: async () => (await ctx.settings()).imageMaxDownloadMb * 1024 * 1024,
    }),
    uploadBytes: createUploader({ signal: ctx.signal }),
  };
}

function configureSlack(fields: Record<string, string>): ConfiguredFields {
  requireFields(CHANNEL_SPECS.slack.fields, fields);
  const botToken = fields.botToken?.trim() ?? "";
  const appToken = fields.appToken?.trim() ?? "";
  if (!botToken.startsWith("xoxb-")) {
    throw new UserFacingError(
      "Slack Bot Token 应以 xoxb- 开头，请到应用后台 OAuth & Permissions 页面复制 Bot User OAuth Token。",
    );
  }
  if (!appToken.startsWith("xapp-")) {
    throw new UserFacingError(
      "Slack App Token 应以 xapp- 开头，请到应用后台 Basic Information → App-Level Tokens 生成（需勾选 connections:write）。",
    );
  }
  const { config, secrets } = defaultConfigure("slack", fields);
  return {
    config: {
      ...config,
      teamId: config.teamId || "__pending__",
      botUserId: config.botUserId || "__pending__",
    },
    secrets,
  };
}

export const definition: ChannelDefinition<SlackConnection> = {
  channel: "slack",
  create: (ctx) => createAdapter(ctx),
  configure: configureSlack,
};

/** 可注入依赖的工厂：defaultDeps 覆盖 REST/WebSocket/文件传输，测试 mock 之。 */
export function createAdapter(
  ctx: AdapterContext<SlackConnection>,
  deps: SlackDeps = defaultDeps(ctx),
): SlackAdapter {
  return new SlackAdapter(ctx, deps);
}
