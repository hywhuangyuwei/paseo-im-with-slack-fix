import { UserFacingError } from "../shared/errors.ts";
import type { ProviderChoice } from "./choices.ts";
import {
  formatCurrentModelNotice,
  formatModelSwitchNotice,
  parseModelCommand,
  resolvePiModel,
} from "./model-command.ts";

export const PASEO_MODEL_NO_TURN_CUSTOM_TYPE = "paseo-model-command";

export interface PiModelLike {
  provider: string;
  id: string;
  name?: string;
}

export interface PiInputEvent {
  type: "input";
  text: string;
  images?: unknown[];
  source: "interactive" | "rpc" | "extension";
  streamingBehavior?: "steer" | "followUp";
}

export type PiInputEventResult =
  | { action: "continue" }
  | { action: "transform"; text: string; images?: unknown[] }
  | { action: "handled" };

export interface PiContextMessage {
  role: string;
  customType?: string;
  [key: string]: unknown;
}

export interface PiContextEvent {
  type: "context";
  messages: PiContextMessage[];
}

export interface PiExtensionContext {
  mode: "tui" | "rpc" | "json" | "print";
  model: PiModelLike | undefined;
  modelRegistry: {
    getAvailable(): PiModelLike[];
  };
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

export interface PiExtensionApi {
  on(
    event: "input",
    handler: (event: PiInputEvent, ctx: PiExtensionContext) => Promise<PiInputEventResult | void> | PiInputEventResult | void,
  ): () => void;
  on(
    event: "context",
    handler: (
      event: PiContextEvent,
      ctx: PiExtensionContext,
    ) => Promise<{ messages?: PiContextMessage[] } | void> | { messages?: PiContextMessage[] } | void,
  ): () => void;
  setModel(model: PiModelLike): Promise<boolean>;
  sendMessage(
    message: { customType: string; content: string; display?: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
}

export function toPiCatalogModelId(model: PiModelLike): string {
  if (!model.provider || model.provider === "pi" || model.id.startsWith(`${model.provider}/`)) {
    return model.id;
  }
  return `${model.provider}/${model.id}`;
}

function completeNoTurnInRpc(
  pi: PiExtensionApi,
  ctx: PiExtensionContext,
  streamingBehavior?: "steer" | "followUp",
): void {
  if (ctx.mode !== "rpc" || streamingBehavior) return;
  pi.sendMessage(
    { customType: PASEO_MODEL_NO_TURN_CUSTOM_TYPE, content: "", display: false },
    { triggerTurn: false },
  );
}

/** Pi extension entry point: intercepts first-line `!m` in Paseo/Pi sessions. */
export default function piModelCommandExtension(pi: PiExtensionApi): void {
  pi.on("context", (event) => {
    const filtered = event.messages.filter(
      (message) => !(message.role === "custom" && message.customType === PASEO_MODEL_NO_TURN_CUSTOM_TYPE),
    );
    return filtered.length === event.messages.length ? undefined : { messages: filtered };
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    const command = parseModelCommand(event.text);
    if (!command) return { action: "continue" };

    try {
      if (!command.query) {
        if (command.body) {
          throw new UserFacingError("用法：!m 单独发送以查询当前模型；如需发送正文，请指定模型关键词或另发一条消息。");
        }
        const currentId = ctx.model ? toPiCatalogModelId(ctx.model) : null;
        ctx.ui.notify(formatCurrentModelNotice(currentId, "pi"), "info");
        completeNoTurnInRpc(pi, ctx, event.streamingBehavior);
        return { action: "handled" };
      }

      const available = ctx.modelRegistry.getAvailable();
      const byId = new Map<string, PiModelLike>();
      const models = available.map((model) => {
        const id = toPiCatalogModelId(model);
        if (!byId.has(id)) byId.set(id, model);
        return { id, label: model.name?.trim() || id, modes: [], thinking: [] };
      });
      const providers: ProviderChoice[] = models.length ? [{ id: "pi", label: "Pi", models }] : [];
      const resolved = resolvePiModel(command.query, providers);
      const target = byId.get(resolved.id);
      if (!target) {
        throw new UserFacingError("Pi 模型切换失败，正文未发送；请在 Paseo 查看详情或换模型重试。");
      }

      let switched = false;
      try {
        switched = await pi.setModel(target);
      } catch {
        throw new UserFacingError("Pi 模型切换失败，正文未发送；请在 Paseo 查看详情或换模型重试。");
      }
      if (!switched) {
        throw new UserFacingError("Pi 模型切换失败，正文未发送；请在 Paseo 查看详情或换模型重试。");
      }
      if (ctx.model && toPiCatalogModelId(ctx.model) !== resolved.id) {
        throw new UserFacingError("Pi 模型切换未能确认，正文未发送；请在 Paseo 中核对当前模型。");
      }

      const notice = formatModelSwitchNotice(resolved.id);
      ctx.ui.notify(notice, "info");
      if (!command.body) {
        completeNoTurnInRpc(pi, ctx, event.streamingBehavior);
        return { action: "handled" };
      }
      return { action: "transform", text: command.body };
    } catch (error) {
      const message =
        error instanceof UserFacingError
          ? error.message
          : "Pi 模型切换失败，正文未发送；请在 Paseo 查看详情或换模型重试。";
      ctx.ui.notify(message, "error");
      completeNoTurnInRpc(pi, ctx, event.streamingBehavior);
      return { action: "handled" };
    }
  });
}
