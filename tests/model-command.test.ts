import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deliveryQueueKey,
  formatCurrentModelNotice,
  formatModelSwitchNotice,
  parseModelCommand,
  resolvePiModel,
} from "../server/model-command.ts";
import piModelCommandExtension, {
  PASEO_MODEL_NO_TURN_CUSTOM_TYPE,
  type PiContextEvent,
  type PiExtensionContext,
  type PiInputEvent,
  type PiInputEventResult,
  type PiModelLike,
} from "../server/pi-model-extension.ts";
import { mapProviderChoices } from "../server/choices.ts";

const providers = mapProviderChoices([
  { provider: "pi", models: [
    { id: "gateway/argon-v1", label: "Argon" },
    { id: "cloud/sol-alpha", label: "Sol A" },
    { id: "cloud/sol-b", label: "Sol B" },
    { id: "local/deepseek-v4.1", label: "DeepSeek 4.1 Local" },
    { id: "remote/deepseek-v4.1", label: "DeepSeek 4.1 Remote" },
  ] },
  { provider: "codex", models: [{ id: "other/argon", label: "Argon" }] },
]);

test("!m first-line parsing: body, no body, CRLF, whitespace, case", () => {
  assert.deepEqual(parseModelCommand("!m sol a\nMESSAGE\nmore"), { query: "sol a", body: "MESSAGE\nmore" });
  assert.deepEqual(parseModelCommand("  !M\targon  \r\n\r\nmessage\r\n"), { query: "argon", body: "message" });
  assert.deepEqual(parseModelCommand("!m argon"), { query: "argon", body: "" });
  assert.deepEqual(parseModelCommand("!m"), { query: "", body: "" });
  for (const text of [null, "hello\n!m argon", "```\n!m argon\n```", "!model argon", "!more", "!m/argon", ""]) {
    assert.equal(parseModelCommand(text), null);
  }
});

test("only a bare model query gets an independent delivery lane", () => {
  for (const text of ["!m", "  !M\t  \r\n\r\n"]) {
    assert.equal(deliveryQueueKey("dm:chat:thread", text), "model-query:dm:chat:thread");
  }
  for (const text of [null, "", "ordinary", "!m argon", "!m argon\nbody", "!m\nbody", "text\n!m", "```\n!m\n```", "!model"]) {
    assert.equal(deliveryQueueKey("dm:chat:thread", text), "conversation:dm:chat:thread");
  }
  assert.equal(deliveryQueueKey("dm:other:thread", "!m"), "model-query:dm:other:thread");
});

test("simple case-insensitive all-term substring matching on Pi ID and label", () => {
  assert.equal(resolvePiModel("ARGON", providers).id, "gateway/argon-v1");
  assert.equal(resolvePiModel("sol a", providers).id, "cloud/sol-alpha");
  assert.equal(resolvePiModel("4.1 local", providers).id, "local/deepseek-v4.1");
  assert.equal(resolvePiModel("local 4.1", providers).id, "local/deepseek-v4.1");
  assert.equal(resolvePiModel("pi/local/deepseek-v4.1", providers).id, "local/deepseek-v4.1");
});

test("exact ID wins over longer substring IDs; duplicate catalog IDs are collapsed", () => {
  const choices = mapProviderChoices([{ provider: "pi", models: [{ id: "x/sol" }, { id: "x/sol-a" }, { id: "x/sol" }] }]);
  assert.equal(resolvePiModel("x/sol", choices).id, "x/sol");
});

test("ambiguous/no match/empty/unavailable never select silently", () => {
  assert.throws(() => resolvePiModel("sol", providers), /匹配到 2 个.*模型未修改[\s\S]*sol-alpha[\s\S]*sol-b/);
  assert.throws(() => resolvePiModel("missing", providers), /没有找到匹配/);
  assert.throws(() => resolvePiModel("", providers), /用法/);
  assert.throws(() => resolvePiModel("argon", []), /没有可查询/);
  const many = mapProviderChoices([{ provider: "pi", models: Array.from({ length: 12 }, (_, i) => ({ id: `p/model-${i}` })) }]);
  assert.throws(() => resolvePiModel("model", many), /匹配到 12 个[\s\S]*仅列出前 10 个/);
});

function createExtensionHarness(options?: {
  mode?: PiExtensionContext["mode"];
  available?: PiModelLike[];
  initialModel?: PiModelLike;
  failSwitch?: boolean;
  skipConfirm?: boolean;
}) {
  const available: PiModelLike[] = options?.available ?? [
    { provider: "gateway", id: "argon-v1", name: "Argon" },
    { provider: "cloud", id: "sol-alpha", name: "Sol A" },
    { provider: "cloud", id: "sol-b", name: "Sol B" },
    { provider: "local", id: "deepseek-v4.1", name: "DeepSeek 4.1 Local" },
  ];
  let currentModel: PiModelLike | undefined = options?.initialModel ?? available[0];
  const notifications: { message: string; type?: string }[] = [];
  const customMessages: { message: { customType: string; content: string; display?: boolean }; options?: { triggerTurn?: boolean } }[] = [];
  const setModelCalls: PiModelLike[] = [];
  let inputHandler: ((event: PiInputEvent, ctx: PiExtensionContext) => Promise<PiInputEventResult | void> | PiInputEventResult | void) | null = null;
  let contextHandler: ((event: PiContextEvent, ctx: PiExtensionContext) => Promise<{ messages?: PiContextEvent["messages"] } | void> | { messages?: PiContextEvent["messages"] } | void) | null = null;

  piModelCommandExtension({
    on(event: "input" | "context", handler: any) {
      if (event === "input") inputHandler = handler;
      if (event === "context") contextHandler = handler;
      return () => {};
    },
    async setModel(model: PiModelLike) {
      setModelCalls.push(model);
      if (options?.failSwitch) return false;
      if (!options?.skipConfirm) currentModel = model;
      return true;
    },
    sendMessage(message, sendOptions) {
      customMessages.push({ message, options: sendOptions });
    },
  });

  const ctx: PiExtensionContext = {
    mode: options?.mode ?? "rpc",
    get model() {
      return currentModel;
    },
    modelRegistry: {
      getAvailable: () => available,
    },
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
    },
  };

  return {
    ctx,
    notifications,
    customMessages,
    setModelCalls,
    get currentModel() {
      return currentModel;
    },
    async sendInput(text: string, overrides?: Partial<PiInputEvent>) {
      assert.ok(inputHandler, "input handler not registered");
      return await inputHandler({ type: "input", text, source: "rpc", ...overrides }, ctx);
    },
    async filterContext(messages: PiContextEvent["messages"]) {
      assert.ok(contextHandler, "context handler not registered");
      return await contextHandler({ type: "context", messages }, ctx);
    },
  };
}

test("Pi extension: bare !m queries current model without LLM turn", async () => {
  const h = createExtensionHarness();
  const result = await h.sendInput("!m");
  assert.deepEqual(result, { action: "handled" });
  assert.equal(h.setModelCalls.length, 0);
  assert.deepEqual(h.notifications, [{ message: formatCurrentModelNotice("gateway/argon-v1", "pi"), type: "info" }]);
  assert.equal(h.customMessages.length, 1);
  assert.equal(h.customMessages[0]!.message.customType, PASEO_MODEL_NO_TURN_CUSTOM_TYPE);
  assert.equal(h.customMessages[0]!.message.display, false);
  assert.equal(h.customMessages[0]!.options?.triggerTurn, false);
});

test("Pi extension: !m switches with and without body using the unified simplified notice", async () => {
  const h = createExtensionHarness();
  const switchOnly = await h.sendInput("!m sol a");
  assert.deepEqual(switchOnly, { action: "handled" });
  assert.equal(h.currentModel?.id, "sol-alpha");
  assert.equal(h.notifications.at(-1)?.message, formatModelSwitchNotice("cloud/sol-alpha"));
  assert.equal(h.notifications.at(-1)?.message, "✅ 已切换模型：cloud/sol-alpha");
  assert.equal(h.customMessages.length, 1);

  const switchWithBody = await h.sendInput("!m 4.1 local\n帮我分析这个问题。");
  assert.deepEqual(switchWithBody, { action: "transform", text: "帮我分析这个问题。" });
  assert.equal(h.currentModel?.id, "deepseek-v4.1");
  assert.equal(h.notifications.at(-1)?.message, formatModelSwitchNotice("local/deepseek-v4.1"));
  assert.equal(h.notifications.at(-1)?.message, "✅ 已切换模型：local/deepseek-v4.1");
  assert.equal(h.customMessages.length, 1, "transform with body must not emit a no-turn completion marker");
});

test("Pi extension: errors and non-!m inputs never leak body to old model", async () => {
  const h = createExtensionHarness();
  for (const [text, pattern] of [
    ["!m\nbody", /单独发送以查询/],
    ["!m sol\nbody", /匹配到 2 个/],
    ["!m missing\nbody", /没有找到匹配/],
  ] as const) {
    const res = await h.sendInput(text);
    assert.deepEqual(res, { action: "handled" });
    assert.equal(h.notifications.at(-1)?.type, "error");
    assert.match(h.notifications.at(-1)!.message, pattern);
  }
  assert.equal(h.setModelCalls.length, 0);

  assert.deepEqual(await h.sendInput("normal message\n!m argon"), { action: "continue" });
  assert.deepEqual(await h.sendInput("!m argon", { source: "extension" }), { action: "continue" });

  const failed = createExtensionHarness({ failSwitch: true });
  assert.deepEqual(await failed.sendInput("!m sol a\nbody"), { action: "handled" });
  assert.match(failed.notifications.at(-1)!.message, /切换失败，正文未发送/);

  const unconfirmed = createExtensionHarness({ skipConfirm: true });
  assert.deepEqual(await unconfirmed.sendInput("!m sol a\nbody"), { action: "handled" });
  assert.match(unconfirmed.notifications.at(-1)!.message, /切换未能确认/);

  const filtered = await h.filterContext([
    { role: "user", content: "hi" },
    { role: "custom", customType: PASEO_MODEL_NO_TURN_CUSTOM_TYPE, content: "" },
    { role: "custom", customType: "other", content: "keep" },
  ]);
  assert.equal(filtered?.messages?.length, 2);
});
