import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { PaseoApi } from "@getpaseo/client";
import { Bridge, messageIdentity, progressIntervalMs, type BridgeDeps } from "../server/bridge.ts";
import { AgentQueue } from "../server/queue.ts";
import { Router } from "../server/routing.ts";
import { StateStore } from "../server/state-store.ts";
import { connectionSchema, emptyPolicy, type Connection } from "../shared/config.ts";
import { imSettings } from "../shared/settings.ts";
import type { ChannelAdapter } from "../server/channels/types.ts";
import type { StageEntry } from "../server/staged-replies.ts";

const connectionId = "00000000-0000-4000-8000-000000000001";
const row = (seq: number, item: object, seqEnd = seq): StageEntry => ({ seqStart: seq, seqEnd, item, turnId: "turn-1" });
const answer = (seq: number, id: string, text: string, end = seq) => row(seq, { type: "assistant_message", messageId: id, text }, end);
const tool = (seq: number, end = seq) => row(seq, { type: "tool_call", name: "bash", status: "completed" }, end);

async function eventually(check: () => boolean) {
  for (let i = 0; i < 1000; i++) { if (check()) return; await delay(1); }
  assert.ok(check(), "fixture condition did not settle");
}

async function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
  const root = await mkdtemp(join(tmpdir(), "im-stages-"));
  const state = new StateStore(connectionId, root);
  await state.load();
  const queue = new AgentQueue();
  const rows: StageEntry[] = [];
  const messages: { id: string; text: string; threadId?: string }[] = [];
  const operations: string[] = [];
  const afterCalls: number[] = [];
  const finish = Promise.withResolvers<{ status: string; lastMessage: string }>();
  const dispatched = Promise.withResolvers<void>();
  let pageSize = 200;
  let gap = false;
  let failSend = false;
  let fetchGate: Promise<void> | null = null;
  let afterHook: ((seq: number) => void) | undefined;
  const controller = new AbortController();
  const adapter: ChannelAdapter = {
    channel: "slack",
    capabilities: { progress: "edit", markdown: "plain", uploadImage: false, uploadFile: false, reactions: false, typing: false, maxChunkChars: 1000, threads: true },
    async start() {}, async stop() {},
    async sendText(out) {
      const id = `out-${messages.length + 1}`;
      messages.push({ id, ...out });
      operations.push(`send:${out.text}`);
      if (failSend) { failSend = false; throw new Error("ambiguous transport"); }
      return { messageId: id };
    },
    async editMessage(id, _chatId, text) {
      messages.find((m) => m.id === id)!.text = text;
      operations.push(`edit:${text}`);
    },
  };
  const agent = {
    async refresh() { return { agent: { id: "agent", provider: "pi", status: "idle", activeTurn: null, archivedAt: null } }; },
    async send(_text: string, opts: { messageId: string }) {
      rows.push(row(1, { type: "user_message", messageId: opts.messageId }));
      dispatched.resolve();
    },
    async waitForFinish() { return finish.promise; },
    timeline: { async refetch(opts: { direction?: string; cursor?: { seq: number }; limit?: number }) {
      if (opts.direction === "after") {
        afterCalls.push(opts.cursor!.seq);
        if (fetchGate) await fetchGate;
        afterHook?.(opts.cursor!.seq);
      }
      const base = opts.cursor?.seq ?? 0;
      // Include overlapping merged tool rows, just like real projection pages.
      const entries = opts.direction === "tail" ? rows.slice(-(opts.limit ?? 1)) : rows.filter((e) => e.seqEnd > base).slice(0, pageSize);
      const end = Math.max(base, entries.at(-1)?.seqStart ?? base);
      return { epoch: "e1", entries, endCursor: { epoch: "e1", seq: end }, hasNewer: opts.direction !== "tail" && rows.some((e) => e.seqStart > end), error: null, reset: false, staleCursor: false, gap: gap ? {} : null };
    } },
  };
  const api = { agents: { ref: () => agent } } as unknown as PaseoApi;
  const config = connectionSchema.parse({ id: connectionId, channel: "slack", name: "test", enabled: true, target: { kind: "agent", agentId: "agent", sharedHistory: false }, policy: emptyPolicy(), bindings: {}, revision: 0, teamId: "TTEST", botUserId: "UTEST" }) as Connection;
  const deps: BridgeDeps = { connectionId, config: () => config, adapter: () => adapter, state, queue, daemon: async () => api, settings: async () => imSettings.schema.parse({}), deferred: { track() {}, resolve() {} }, signal: controller.signal, log() {} };
  const bridge = new Bridge(deps, new Router(deps.daemon));
  const message = { channel: "slack" as const, connectionId, kind: "dm" as const, chatId: "channel", threadId: "thread", senderId: "user", messageId: "m1", timestamp: Date.now(), text: "检查", trigger: { mention: false, replyToBot: false, command: false } };
  const start = async () => { await bridge.handle(message); await dispatched.promise; await eventually(() => state.job("m1")?.dispatch === "sent"); };
  const done = async (text = "最终回复") => { finish.resolve({ status: "idle", lastMessage: text }); await queue.idle(); await state.drain(); };
  t.after(async () => { finish.resolve({ status: "idle", lastMessage: "cleanup" }); await queue.idle(); await state.drain(); t.mock.timers.reset(); await rm(root, { recursive: true, force: true }); });
  return { state, rows, messages, operations, afterCalls, deps, bridge, start, done, controller,
    tick: (ms = 5000) => t.mock.timers.tick(ms),
    setPageSize: (v: number) => { pageSize = v; }, setGap: () => { gap = true; }, failNextSend: () => { failSend = true; },
    blockFetch: (gate: Promise<void> | null) => { fetchGate = gate; },
    onAfterFetch: (hook: (seq: number) => void) => { afterHook = hook; },
  };
}

test("5 秒节拍：阶段正文立即保留到原 thread，总耗时不中断，最终答案排在最后", async (t) => {
  const h = await fixture(t);
  assert.equal(progressIntervalMs, 5000);
  await h.start();
  h.rows.push(answer(2, "a", "先检查实现"), tool(3));
  h.tick(4999);
  assert.equal(h.afterCalls.length, 0);
  h.tick(1);
  await eventually(() => h.state.job("m1")?.stagedReplies?.delivered.length === 1);
  assert.equal(h.messages[0]?.text, "先检查实现");
  assert.match(h.messages[1]!.text, /^⏳ 5s/);
  await h.state.drain();
  await delay(1); // finish the first refresh's activity edit/finally before next tick
  h.rows.push(answer(4, "b", "再检查测试"), tool(5));
  h.tick();
  await eventually(() => h.state.job("m1")?.stagedReplies?.delivered.length === 2);
  h.rows.push(answer(6, "final", "最终回复"));
  await h.done();
  assert.deepEqual(h.messages.map((m) => m.text), ["先检查实现", "再检查测试", "最终回复"]);
  assert.ok(h.messages.every((m) => m.threadId === "thread"));
  assert.ok(h.operations.some((op) => op.includes("⏳ 10s")));
  const count = h.operations.length;
  h.tick(10000);
  await delay(1);
  assert.equal(h.operations.length, count);
});

test("增长中的尾部正文不提前提交；收尾补齐已确认阶段", async (t) => {
  const h = await fixture(t);
  await h.start();
  h.rows.push(answer(2, "a", "尚未"));
  h.tick();
  await eventually(() => h.afterCalls.length === 1);
  await h.state.drain();
  assert.equal(h.state.job("m1")?.stagedReplies, undefined);
  h.rows[1] = answer(2, "a", "完整的阶段回复", 3);
  h.rows.push(tool(4), answer(5, "final", "最终回复"));
  await h.done();
  assert.deepEqual(h.messages.map((m) => m.text), ["完整的阶段回复", "最终回复"]);
});

test("重复轮询不重复阶段；分页用 endCursor，不跳过跨段工具", async (t) => {
  const h = await fixture(t);
  await h.start();
  h.setPageSize(2);
  h.rows.push(answer(2, "a", "阶段一"), tool(3, 8), answer(4, "b", "阶段二"), tool(5), answer(6, "final", "最终回复"));
  h.tick();
  await eventually(() => h.state.job("m1")?.stagedReplies?.delivered.length === 2);
  assert.ok(h.afterCalls.includes(4), "page cursor follows endCursor past the overlapped tool");
  assert.ok(!h.afterCalls.includes(8), "must not jump to the merged tool's max seqEnd");
  h.tick();
  await h.done();
  assert.deepEqual(h.messages.map((m) => m.text), ["阶段一", "阶段二", "最终回复"]);
});

test("慢时间线请求跳过重叠 tick；最终回复等待在途阶段轮转，不能被迟到计时反盖", async (t) => {
  const h = await fixture(t);
  await h.start();
  h.rows.push(answer(2, "a", "阶段"), tool(3));
  const gate = Promise.withResolvers<void>();
  h.blockFetch(gate.promise);
  h.tick();
  await eventually(() => h.afterCalls.length === 1);
  h.tick(15000);
  assert.equal(h.afterCalls.length, 1);
  h.rows.push(answer(4, "final", "最终回复"));
  const done = h.done();
  gate.resolve();
  await done;
  assert.deepEqual(h.messages.map((m) => m.text), ["阶段", "最终回复"]);
  assert.equal(h.operations.at(-1), "edit:最终回复");
});

test("阶段之后只有工具、没有新正文时不重复发送 lastMessage", async (t) => {
  const h = await fixture(t);
  await h.start();
  h.rows.push(answer(2, "a", "阶段即最后正文"), tool(3));
  h.tick();
  await eventually(() => h.state.job("m1")?.stagedReplies?.delivered.length === 1);
  await h.done("阶段即最后正文");
  assert.equal(h.messages.filter((m) => m.text === "阶段即最后正文").length, 1);
  assert.match(h.messages.at(-1)!.text, /^✅ 已完成/);
  assert.equal(h.state.job("m1")?.answer, "阶段即最后正文");
});

test("时间线缺口/其他用户输入不转发阶段；最终回复仍走原有路径", async (t) => {
  for (const reason of ["gap", "other-input"]) {
    await t.test(reason, async (t) => {
      const h = await fixture(t);
      await h.start();
      h.rows.push(answer(2, "a", "不可安全归属"), tool(3));
      if (reason === "gap") h.setGap();
      else h.rows.push(row(4, { type: "user_message", messageId: "other" }));
      await h.done();
      assert.deepEqual(h.messages.map((m) => m.text), ["最终回复"]);
    });
  }
});

test("阶段发送不确定不重发、不覆盖正文，最终回复仍可送出", async (t) => {
  const h = await fixture(t);
  await h.start();
  h.rows.push(answer(2, "a", "已编辑阶段"), tool(3));
  h.failNextSend();
  h.tick();
  await eventually(() => h.state.job("m1")?.stagedReplies?.uncertain === true);
  h.rows.push(answer(4, "final", "最终回复"));
  h.tick();
  await h.done();
  assert.equal(h.messages[0]?.text, "已编辑阶段");
  assert.equal(h.messages.filter((m) => m.text === "已编辑阶段").length, 1);
  assert.equal(h.messages.at(-1)?.text, "最终回复");
});

test("重载恢复复用当前计时且不重发已确认阶段", async (t) => {
  const h = await fixture(t);
  const identity = messageIdentity(connectionId, "m1");
  h.rows.push(row(1, { type: "user_message", messageId: identity }), answer(2, "a", "已保留阶段"), tool(3), answer(4, "final", "最终回复"));
  h.messages.push({ id: "old-stage", text: "已保留阶段", threadId: "thread" }, { id: "old-clock", text: "⏳ 5s", threadId: "thread" });
  h.state.ensureJob("m1", { messageId: "m1", conversationKey: "dm:channel:thread", chatId: "channel", threadId: "thread", senderId: "user", agentId: "agent", dispatch: "sent", after: { epoch: "e1", seq: 0 }, progressMessageId: "old-clock", createdAt: Date.now(), stagedReplies: { delivered: ["a"], last: { id: "a", text: "已保留阶段" }, sending: null, uncertain: false } });
  await h.state.drain();
  await h.state.mutate(() => {}); // ensureJob seeds memory, not disk
  const restored = new StateStore(connectionId, rootOf(h.state.path));
  await restored.load();
  const deps = { ...h.deps, state: restored };
  const bridge = new Bridge(deps, new Router(deps.daemon));
  const resume = bridge.rerunQueued("m1");
  await h.done();
  await resume;
  await restored.drain();
  assert.deepEqual(h.messages.map((m) => m.text), ["已保留阶段", "最终回复"]);
});

function rootOf(path: string) { return path.slice(0, path.lastIndexOf("/")); }

test("重载中断阶段轮转时放弃不确定占位，防止覆盖已发正文", async (t) => {
  const h = await fixture(t);
  h.messages.push({ id: "uncertain", text: "可能已经封存的阶段", threadId: "thread" });
  h.state.ensureJob("m1", { messageId: "m1", conversationKey: "dm:channel:thread", chatId: "channel", threadId: "thread", senderId: "user", agentId: "agent", dispatch: "sent", after: { epoch: "e1", seq: 0 }, progressMessageId: "uncertain", createdAt: Date.now(), stagedReplies: { delivered: [], last: null, sending: "a", uncertain: false } });
  const resume = h.bridge.rerunQueued("m1");
  await h.done();
  await resume;
  assert.deepEqual(h.messages.map((m) => m.text), ["可能已经封存的阶段", "最终回复"]);
  assert.equal(h.state.job("m1")?.stagedReplies?.uncertain, true);
});

test("翻页期间旧投影正文增长：合并更新后的行，不封存截断旧版本", async (t) => {
  const h = await fixture(t);
  await h.start();
  h.rows.push(answer(2, "a", "部分"), tool(4), answer(5, "final", "最终回复"));
  h.setPageSize(2);
  h.onAfterFetch((seq) => {
    if (seq === 2) h.rows[1] = answer(2, "a", "完整的阶段回复", 3);
  });
  h.tick();
  await eventually(() => h.state.job("m1")?.stagedReplies?.delivered.length === 1);
  await h.done();
  assert.deepEqual(h.messages.map((m) => m.text), ["完整的阶段回复", "最终回复"]);
});

test("deferred 完成共享阶段去重，普通请求及带正文 !m 都不重复最后正文", async (t) => {
  for (const command of [false, true]) {
    await t.test(command ? "!m body" : "ordinary", async (t) => {
      const h = await fixture(t);
      const text = "已展示的最后正文";
      h.rows.push(row(1, { type: "user_message", messageId: messageIdentity(connectionId, "m1") }), answer(2, "a", text), tool(3));
      h.messages.push({ id: "old-stage", text, threadId: "thread" }, { id: "old-clock", text: "任务未完成，请在 Paseo 中查看详情。", threadId: "thread" }, { id: "timeout", text: "等待模型回复超时。", threadId: "thread" });
      h.state.ensureJob("m1", { messageId: "m1", conversationKey: "dm:channel:thread", chatId: "channel", threadId: "thread", senderId: "user", text: command ? "!m argon\n检查" : "检查", agentId: "agent", dispatch: "sent", after: { epoch: "e1", seq: 0 }, progressMessageId: "old-clock", answer: command ? text : null, deadlineAt: Date.now() + 60000, createdAt: Date.now() - 60000, stagedReplies: { delivered: ["a"], last: { id: "a", text }, sending: null, uncertain: false } });
      await h.done(text);
      assert.equal(await h.bridge.resumeDeferred("m1"), true);
      assert.equal(h.messages.filter((m) => m.text === text).length, 1);
      assert.match(h.messages.at(-1)!.text, /^✅ 已完成/);
      assert.equal(h.state.job("m1")?.delivery, "done");
    });
  }
});

test("deferred 结束时补齐超时后新增阶段，最终答案仍在 timeout 通知和阶段之后", async (t) => {
  const h = await fixture(t);
  h.rows.push(row(1, { type: "user_message", messageId: messageIdentity(connectionId, "m1") }), answer(2, "a", "原阶段"), tool(3), answer(4, "b", "超时后的阶段"), tool(5), answer(6, "final", "最终回复"));
  h.messages.push({ id: "old-stage", text: "原阶段", threadId: "thread" }, { id: "timeout", text: "等待模型回复超时。", threadId: "thread" });
  h.state.ensureJob("m1", { messageId: "m1", conversationKey: "dm:channel:thread", chatId: "channel", threadId: "thread", senderId: "user", agentId: "agent", dispatch: "sent", after: { epoch: "e1", seq: 0 }, deadlineAt: Date.now() + 60000, createdAt: Date.now() - 60000, stagedReplies: { delivered: ["a"], last: { id: "a", text: "原阶段" }, sending: null, uncertain: false } });
  await h.done();
  assert.equal(await h.bridge.resumeDeferred("m1"), true);
  assert.deepEqual(h.messages.map((m) => m.text), ["原阶段", "等待模型回复超时。", "超时后的阶段", "最终回复"]);
});

test("不足 5 秒的短任务也在首次 tick 之前补齐完整阶段", async (t) => {
  const h = await fixture(t);
  await h.start();
  h.rows.push(answer(2, "a", "快速阶段"), tool(3), answer(4, "final", "最终回复"));
  await h.done();
  assert.deepEqual(h.messages.map((m) => m.text), ["快速阶段", "最终回复"]);
});

test("阶段回复与既有后台续跑共存，不重复初轮阶段或最终回复", async (t) => {
  const h = await fixture(t);
  const tracked: string[] = [];
  h.deps.followups = { track: (id) => tracked.push(id) };
  await h.start();
  h.rows.push(answer(2, "stage", "先启动后台任务"), row(3, { type: "tool_call", name: "bg_run", status: "completed", detail: { output: { details: { task: { id: "task-1", notifyOnCompletion: true, triggerOnCompletion: true } } } } }), answer(4, "initial", "正在后台处理"));
  await h.done("正在后台处理");
  assert.deepEqual(tracked, ["m1"]);
  assert.equal(await h.bridge.resumeFollowup("m1"), false);
  h.rows.push(row(5, { type: "tool_call", name: "background-task-notification", metadata: { synthetic: true, customType: "background-task-notification", details: { id: "task-1", triggerOnCompletion: true } } }), answer(6, "followup", "后台最终结果"));
  assert.equal(await h.bridge.resumeFollowup("m1"), true);
  assert.deepEqual(h.messages.map((m) => m.text), ["先启动后台任务", "正在后台处理", "后台最终结果"]);
});
