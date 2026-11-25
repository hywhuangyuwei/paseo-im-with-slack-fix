import type { ChannelAdapter, AdapterContext } from "./channels/types.ts";
import type { SendResult } from "../shared/model.ts";
import { splitChunks } from "./format/chunks.ts";

const PLACEHOLDER = "⏳ 正在处理…";

/** Per-conversation progress lifecycle driven by the bridge. The backend
 * follows the channel capability: edit in place, native stream, typing
 * indicator, or nothing. */
export interface ProgressSink {
  readonly messageId: string | null;
  start(): Promise<void>;
  refresh(elapsedSeconds: number, activity?: string): Promise<void>;
  /** Slack only: preserve the current placeholder as a completed stage, then
   * move the clock to a new trailing message in the same thread. */
  stage(text: string, elapsedSeconds: number): Promise<void>;
  /** In-place completion for edit/stream channels; null means the bridge must
   * deliver every chunk itself. */
  finish(answer: string): Promise<SendResult | null>;
  abandon(): Promise<void>;
}

export function createProgressSink(
  adapter: ChannelAdapter,
  chatId: string,
  threadId: string | undefined,
  log: AdapterContext["log"],
  existingMessageId?: string | null,
): ProgressSink {
  const mode = adapter.capabilities.progress;
  let messageId: string | null = mode === "edit" ? existingMessageId ?? null : null;
  let streamId: string | null = null;
  let started = messageId !== null;
  let closed = false;
  let lastLine = "";
  let inFlight: Promise<void> | null = null;

  function track(task: Promise<void>): Promise<void> {
    const wrapped = task.finally(() => {
      if (inFlight === wrapped) inFlight = null;
    });
    inFlight = wrapped;
    return wrapped;
  }

  async function editInPlace(text: string): Promise<void> {
    if (!messageId) return;
    await adapter.editMessage!(messageId, chatId, text).catch((error) => {
      log("warn", `进度消息更新失败：${(error as Error).message}`);
    });
  }

  return {
    get messageId() {
      return messageId ?? streamId;
    },
    async start() {
      if (mode === "none" || closed || started) return;
      await track(
        (async () => {
          if (mode === "typing") {
            await adapter.sendTyping?.(chatId).catch(() => {});
            started = true;
            return;
          }
          if (mode === "edit") {
            const sent = await adapter.sendText({ chatId, threadId, text: PLACEHOLDER });
            messageId = sent.messageId ?? null;
            if (messageId) adapter.rememberOwnMessage?.(messageId);
            lastLine = PLACEHOLDER;
            started = true;
            return;
          }
          if (adapter.streamStart) {
            const stream = await adapter.streamStart(chatId, threadId);
            streamId = stream.streamId;
            started = true;
          }
        })(),
      );
    },
    async refresh(elapsedSeconds, activity) {
      if (mode === "none" || closed || !started || inFlight !== null) return;
      if (mode === "typing") {
        await track(adapter.sendTyping?.(chatId).catch(() => {}) ?? Promise.resolve());
        return;
      }
      const line = activity ? `⏳ ${elapsedSeconds}s · ${activity}` : `⏳ ${elapsedSeconds}s`;
      if (line === lastLine) return;
      if (mode === "edit") {
        await track(
          (async () => {
            if (closed || !messageId) return;
            await editInPlace(line);
            lastLine = line;
          })(),
        );
        return;
      }
      if (streamId && adapter.streamAppend) {
        const id = streamId;
        await track(
          (async () => {
            if (closed) return;
            await adapter.streamAppend!(id, line).catch((error) => {
              log("warn", `流式进度更新失败：${(error as Error).message}`);
            });
            lastLine = line;
          })(),
        );
      }
    },
    async stage(text, elapsedSeconds) {
      if (closed || !started || adapter.channel !== "slack" || mode !== "edit") return;
      const previous = inFlight;
      await track((async () => {
        if (previous) await previous.catch(() => {});
        const chunks = splitChunks(text, adapter.capabilities.maxChunkChars);
        const oldId = messageId;
        // Detach BEFORE any external effect: if an edit/send fails ambiguously,
        // finalization must never overwrite a possibly preserved stage.
        messageId = null;
        for (const [index, chunk] of chunks.entries()) {
          if (index === 0 && oldId) {
            await adapter.editMessage!(oldId, chatId, chunk);
          } else {
            const sent = await adapter.sendText({ chatId, threadId, text: chunk });
            if (sent.uncertain) throw new Error("阶段回复发送状态不确定");
            if (sent.messageId) adapter.rememberOwnMessage?.(sent.messageId);
          }
        }
        const line = `⏳ ${elapsedSeconds}s · 继续处理中…`;
        const sent = await adapter.sendText({ chatId, threadId, text: line });
        if (sent.uncertain) throw new Error("进度消息发送状态不确定");
        messageId = sent.messageId ?? null;
        if (messageId) adapter.rememberOwnMessage?.(messageId);
        lastLine = line;
      })());
    },
    async finish(answer): Promise<SendResult | null> {
      closed = true;
      if (mode === "none" || mode === "typing") return null;
      if (inFlight) await inFlight.catch(() => {});
      if (mode === "edit" && messageId) {
        await adapter.editMessage!(messageId, chatId, answer);
        return { messageId };
      }
      if (mode === "stream" && streamId && adapter.streamFinish) {
        const result = await adapter.streamFinish(streamId, answer);
        return { messageId: result.messageId };
      }
      return null;
    },
    async abandon() {
      closed = true;
      if (mode === "none" || mode === "typing") return;
      if (inFlight) await inFlight.catch(() => {});
      if (mode === "edit" && messageId) {
        await editInPlace("任务未完成，请在 Paseo 中查看详情。");
      }
    },
  };
}
