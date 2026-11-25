import assert from "node:assert/strict";
import { test } from "node:test";
import { collectStagedReplies, type StageEntry } from "../server/staged-replies.ts";
import { createProgressSink } from "../server/progress.ts";
import type { ChannelAdapter } from "../server/channels/types.ts";

const row = (seq: number, item: object, seqEnd = seq, turnId = "turn-1"): StageEntry => ({ seqStart: seq, seqEnd, item, turnId });
const origin = row(1, { type: "user_message", messageId: "origin" });
const reply = (seq: number, id: string, text: string, end = seq) => row(seq, { type: "assistant_message", messageId: id, text }, end);
const tool = (seq: number, end = seq) => row(seq, { type: "tool_call", name: "bash", status: "running" }, end);

test("阶段识别：只保留后面已有工具/新正文的完整段，尾部正文仍走最终回复", () => {
  assert.deepEqual(collectStagedReplies([origin, reply(2, "a", "先检查"), tool(3), reply(4, "b", "最终回复")], "origin"), {
    stages: [{ id: "a", text: "先检查" }], last: { id: "b", text: "最终回复" },
  });
  assert.deepEqual(collectStagedReplies([origin, reply(2, "a", "先检查"), reply(3, "b", "再验证"), tool(4)], "origin")?.stages,
    [{ id: "a", text: "先检查" }, { id: "b", text: "再验证" }]);
});

test("阶段识别：增长中的正文、reasoning、todo 和工具输出不会被误当成阶段回复", () => {
  const rows = [origin, reply(2, "a", "正在"), row(3, { type: "reasoning", text: "private reasoning" }), row(4, { type: "todo", items: [] })];
  assert.deepEqual(collectStagedReplies(rows, "origin")?.stages, []);
  rows[1] = reply(2, "a", "正在检查，正文增长中", 5);
  assert.deepEqual(collectStagedReplies(rows, "origin")?.stages, []);
  assert.deepEqual(collectStagedReplies([origin, tool(2)], "origin"), { stages: [], last: null });
});

test("阶段识别：旧工具的重叠 seqEnd 不会封存新正文；无模型 ID 的工具图片/扩展内容不转发", () => {
  assert.deepEqual(collectStagedReplies([origin, tool(2, 10), reply(3, "a", "尚在生成", 5)], "origin")?.stages, []);
  assert.deepEqual(collectStagedReplies([origin, tool(2), row(3, { type: "assistant_message", text: "![tool image](private-image)" }), reply(4, "model", "模型真正的答复"), tool(5)], "origin")?.stages,
    [{ id: "model", text: "模型真正的答复" }]);
});

test("阶段识别：同一模型消息被 reasoning/旧工具更新分成多行时聚合所有正文片段", () => {
  const rows = [origin, tool(2, 8), reply(3, "a", "前半段\n"), row(4, { type: "reasoning", text: "do not relay" }), reply(5, "a", "后半段"), tool(6), reply(7, "b", "最终回复")];
  assert.deepEqual(collectStagedReplies(rows, "origin"), { stages: [{ id: "a", text: "前半段\n后半段" }], last: { id: "b", text: "最终回复" } });
});

test("阶段识别：clientMessageId 可关联原输入；无原输入、新用户/自动唤醒/异轮输出一律不转发", () => {
  const rows = [origin, reply(2, "a", "先检查"), tool(3)];
  assert.equal(collectStagedReplies(rows.slice(1), "origin"), null);
  assert.equal(collectStagedReplies([...rows, row(4, { type: "user_message", messageId: "other" })], "origin"), null);
  assert.equal(collectStagedReplies([...rows, row(4, { type: "tool_call", name: "background-task-notification" })], "origin"), null);
  assert.equal(collectStagedReplies([...rows, { ...reply(4, "b", "other turn"), turnId: "turn-2" }], "origin"), null);
  assert.equal(collectStagedReplies([{ ...origin, item: { type: "user_message", clientMessageId: "origin" } }, ...rows.slice(1)], "origin")?.stages.length, 1);
});

function recorder(maxChunkChars = 1000, channel: ChannelAdapter["channel"] = "slack") {
  const messages: { id: string; text: string; chatId: string; threadId?: string }[] = [];
  const operations: string[] = [];
  const adapter: ChannelAdapter = {
    channel,
    capabilities: { progress: "edit", markdown: "plain", uploadImage: false, uploadFile: false, reactions: false, typing: false, maxChunkChars, threads: true },
    async start() {}, async stop() {},
    async sendText(out) {
      const id = `out-${messages.length + 1}`;
      messages.push({ id, ...out });
      operations.push(`send:${out.text}`);
      return { messageId: id };
    },
    async editMessage(id, _chatId, text) {
      messages.find((m) => m.id === id)!.text = text;
      operations.push(`edit:${text}`);
    },
  };
  return { messages, operations, adapter, sink: () => createProgressSink(adapter, "channel", "thread", () => {}) };
}

test("Slack 阶段轮转：正文无前缀保留，计时接续且最终答案在最后", async () => {
  const h = recorder();
  const sink = h.sink();
  await sink.start();
  await sink.refresh(5, "正在思考…");
  await sink.stage("我先检查实现。", 10);
  await sink.refresh(15, "正在执行测试…");
  await sink.stage("已经定位问题。", 20);
  await sink.finish("修复完成。");
  await sink.refresh(25, "不得盖掉正文");
  await sink.stage("不得再发送阶段", 25);
  assert.deepEqual(h.messages.map((m) => m.text), ["我先检查实现。", "已经定位问题。", "修复完成。"]);
  assert.ok(h.messages.every((m) => m.chatId === "channel" && m.threadId === "thread"));
  assert.ok(h.operations.includes("edit:⏳ 15s · 正在执行测试…"));
  assert.equal(sink.messageId, "out-3");
});

test("Slack 阶段轮转等待慢刷新，finish 等待整次轮转，旧计时不会覆盖正文", async () => {
  const h = recorder();
  const gate = Promise.withResolvers<void>();
  const edit = h.adapter.editMessage!;
  h.adapter.editMessage = async (...args) => { if (args[2].startsWith("⏳ 5s")) await gate.promise; await edit(...args); };
  const sink = h.sink();
  await sink.start();
  const refreshing = sink.refresh(5, "正在思考…");
  const rotating = sink.stage("完整阶段", 10);
  await sink.refresh(15, "跳过重叠更新");
  const finishing = sink.finish("最终结果");
  gate.resolve();
  await Promise.all([refreshing, rotating, finishing]);
  assert.deepEqual(h.messages.map((m) => m.text), ["完整阶段", "最终结果"]);
  assert.equal(h.operations.at(-1), "edit:最终结果");
});

test("Slack 长阶段先分块再创建新计时；非 Slack 不启用阶段轮转", async () => {
  const h = recorder(12);
  const sink = h.sink();
  await sink.start();
  const text = "第一阶段的完整正文很长，需要被拆成多个块。";
  await sink.stage(text, 15);
  assert.equal(h.messages.slice(0, -1).map((m) => m.text).join(""), text);
  assert.equal(h.messages.at(-1)?.text, "⏳ 15s · 继续处理中…");
  await sink.finish("最终答案");
  const other = recorder(1000, "telegram");
  const otherSink = other.sink();
  await otherSink.start();
  await otherSink.stage("不应启用", 10);
  assert.equal(other.messages.length, 1);
  await otherSink.finish("原有最终回复");
  assert.equal(other.messages[0]?.text, "原有最终回复");
});

test("Slack 阶段发送不确定时 detach 旧消息，最终答案不能覆盖阶段正文", async () => {
  const h = recorder();
  const sink = h.sink();
  await sink.start();
  const send = h.adapter.sendText;
  h.adapter.sendText = async (out) => { await send(out); throw new Error("transport lost after send"); };
  await assert.rejects(sink.stage("已保留阶段", 10), /transport/);
  assert.equal(sink.messageId, null);
  assert.equal(await sink.finish("最终答案另发"), null);
  assert.equal(h.messages[0]?.text, "已保留阶段");
});

test("Slack 重载可复用已持久化计时消息；abandon 只改当前计时，不改已封存阶段", async () => {
  const h = recorder();
  const sink = h.sink();
  await sink.start();
  await sink.stage("已保留阶段", 10);
  const restored = createProgressSink(h.adapter, "channel", "thread", () => {}, sink.messageId);
  await restored.start();
  assert.equal(h.messages.length, 2);
  await restored.abandon();
  assert.deepEqual(h.messages.map((m) => m.text), ["已保留阶段", "任务未完成，请在 Paseo 中查看详情。"]);
});
