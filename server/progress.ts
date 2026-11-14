import type { ChannelAdapter, AdapterContext } from "./channels/types.ts";
import type { SendResult } from "../shared/model.ts";

const PLACEHOLDER = "⏳ 正在处理…";

/** Per-conversation progress lifecycle driven by the bridge. The backend
 * follows the channel capability: edit in place, native stream, typing
 * indicator, or nothing. */
export interface ProgressSink {
  readonly messageId: string | null;
  start(): Promise<void>;
  refresh(elapsedSeconds: number, activity?: string): Promise<void>;
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
): ProgressSink {
  const mode = adapter.capabilities.progress;
  let messageId: string | null = null;
  let streamId: string | null = null;
  let started = false;
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
