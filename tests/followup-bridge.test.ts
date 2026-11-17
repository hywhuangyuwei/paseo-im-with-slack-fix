import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { Bridge, messageIdentity, type BridgeDeps } from "../server/bridge.ts";
import { AgentQueue } from "../server/queue.ts";
import { Router } from "../server/routing.ts";
import { StateStore } from "../server/state-store.ts";
import { connectionSchema, emptyPolicy, type Connection } from "../shared/config.ts";
import { imSettings } from "../shared/settings.ts";
import type { ChannelAdapter } from "../server/channels/types.ts";
import type { OutboundText } from "../shared/model.ts";

const connectionId = "00000000-0000-4000-8000-000000000001";
const identity = messageIdentity(connectionId, "m1");
const entry = (seq: number, item: object, seqEnd = seq) => ({ seqStart: seq, seqEnd, item });
const launch = (id: string) => ({ type: "tool_call", name: "bg_run", status: "completed", detail: { output: { details: { task: { id, notifyOnCompletion: true, triggerOnCompletion: true } } } } });
const notification = (id: string) => ({ type: "tool_call", name: "background-task-notification", metadata: { synthetic: true, customType: "background-task-notification", details: { id, triggerOnCompletion: true } } });
const answer = (id: string, text: string) => ({ type: "assistant_message", messageId: id, text });

async function fixture(run: (h: {
  bridge: Bridge;
  state: StateStore;
  queue: AgentQueue;
  entries: ReturnType<typeof entry>[];
  sent: OutboundText[];
  tracked: string[];
  setRunning: (v: boolean) => void;
  setFail: (v: boolean) => void;
  setNextReply: (text: string, onSend?: () => void) => void;
  reopen: () => Promise<StateStore>;
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "im-followup-"));
  const state = new StateStore(connectionId, root);
  const queue = new AgentQueue();
  const entries = [entry(1, { type: "user_message", messageId: identity }), entry(2, launch("task-1"), 4), entry(3, answer("a1", "处理中"))];
  const sent: OutboundText[] = [];
  const tracked: string[] = [];
  let running = false;
  let fail = false;
  let nextReply = "新消息回复";
  let onSendHook: (() => void) | undefined;
  const adapter: ChannelAdapter = {
    channel: "slack",
    capabilities: { progress: "none", markdown: "plain", uploadImage: false, uploadFile: false, reactions: false, typing: false, maxChunkChars: 4000, threads: true },
    async start() {}, async stop() {},
    async sendText(out) { sent.push(out); if (fail) throw new Error("transport lost after send"); return { messageId: "sent" }; },
  };
  const agent = {
    async refresh() { return { agent: { id: "a1", provider: "pi", runtimeInfo: { model: "self-hosted/model-a" }, status: running ? "running" : "idle", activeTurn: running ? {} : null, archivedAt: null } }; },
    async send(_text: string, opts: { messageId: string }) {
      const nextSeq = Math.max(0, ...entries.map((e) => e.seqEnd)) + 1;
      entries.push(entry(nextSeq, { type: "user_message", messageId: opts.messageId }));
      onSendHook?.();
      const ansSeq = Math.max(0, ...entries.map((e) => e.seqEnd)) + 1;
      entries.push(entry(ansSeq, answer(`ans-${ansSeq}`, nextReply)));
    },
    async waitForFinish() { return { status: "idle", lastMessage: nextReply }; },
    timeline: { async refetch({ direction, cursor, limit }: { direction?: string; cursor?: { epoch: string; seq: number }; limit?: number }) {
      if (direction === "tail") {
        const rows = entries.slice(-(limit ?? 1));
        const last = Math.max(0, ...rows.map((e) => e.seqStart));
        return { epoch: "e1", entries: rows, endCursor: { epoch: "e1", seq: last }, hasNewer: false, error: null, reset: false, staleCursor: false, gap: null };
      }
      // Deliberately include overlapping projected entries to exercise cursor logic.
      const base = cursor?.seq ?? 0;
      const rows = entries.filter((e) => e.seqEnd > base).slice(0, 2);
      const last = Math.max(base, rows.at(-1)?.seqStart ?? base);
      return { epoch: "e1", entries: rows, endCursor: { epoch: "e1", seq: last }, hasNewer: entries.some((e) => e.seqStart > last), error: null, reset: false, staleCursor: false, gap: null };
    } },
  };
  const api = { agents: { ref: () => agent } } as unknown as PaseoApi;
  const config = connectionSchema.parse({ id: connectionId, channel: "slack", name: "test", enabled: true, target: { kind: "agent", agentId: "a1", sharedHistory: false }, policy: { ...emptyPolicy(), groupUsers: "everyone" }, bindings: {}, revision: 0, teamId: "TTEST", botUserId: "UTEST" }) as Connection;
  const deps: BridgeDeps = { connectionId, config: () => config, adapter: () => adapter, state, queue, daemon: async () => api, settings: async () => imSettings.schema.parse({}), deferred: { track() {}, resolve() {} }, followups: { track: (id) => tracked.push(id) }, signal: new AbortController().signal, log() {} };
  const bridge = new Bridge(deps, new Router(deps.daemon));
  try {
    await state.load();
    state.ensureJob("m1", { messageId: "m1", conversationKey: "group:channel:thread", chatId: "channel", threadId: "thread", senderId: "user", createdAt: 1, agentId: "a1", dispatch: "sent", after: { epoch: "e1", seq: 0 }, answer: "处理中", delivery: "done", followup: { cursor: { epoch: "e1", seq: 0 }, originSeen: false, pendingTasks: [], waitingForReply: false, candidate: null, lastAnswer: "处理中", sending: null, uncertain: false, expiresAt: Date.now() + 100_000 } });
    await state.mutate((s) => {
      s.conversations["group:channel:thread"] = { agentId: "a1", workspaceId: null, title: null, updatedAt: Date.now() };
      s.groups["channel"] = { title: "channel" };
    });
    await run({
      bridge, state, queue, entries, sent, tracked,
      setRunning: (v) => { running = v; },
      setFail: (v) => { fail = v; },
      setNextReply: (text, onSend) => { nextReply = text; onSendHook = onSend; },
      reopen: async () => { await state.drain(); const other = new StateStore(connectionId, root); await other.load(); return other; },
    });
  } finally { await queue.idle(); await state.drain(); await rm(root, { recursive: true, force: true }); }
}

test("后台任务完成后的最终回复投递一次，并保持原 thread", async () => {
  await fixture(async (h) => {
    assert.equal(await h.bridge.resumeFollowup("m1"), false);
    assert.deepEqual(h.state.job("m1")?.followup?.pendingTasks, ["task-1"]);
    h.entries.push(entry(4, notification("task-1")), entry(5, answer("a2", "最终结果")));
    h.setRunning(true);
    assert.equal(await h.bridge.resumeFollowup("m1"), false);
    assert.equal(h.sent.length, 0);
    h.setRunning(false);
    assert.equal(await h.bridge.resumeFollowup("m1"), true);
    assert.deepEqual(h.sent.map(({ chatId, threadId, text }) => ({ chatId, threadId, text })), [{ chatId: "channel", threadId: "thread", text: "最终结果" }]);
    assert.equal((await h.reopen()).job("m1")?.followup, null);
    assert.equal(await h.bridge.resumeFollowup("m1"), true);
    assert.equal(h.sent.length, 1);
  });
});

test("运行中任务的游标与身份可持久化恢复", async () => {
  await fixture(async (h) => {
    assert.equal(await h.bridge.resumeFollowup("m1"), false);
    const restored = (await h.reopen()).job("m1")?.followup;
    assert.deepEqual(restored?.pendingTasks, ["task-1"]);
    assert.equal(restored?.cursor.seq, 3);
    assert.equal(restored?.originSeen, true);
  });
});

test("Paseo 中其他用户插话时不泄露其答复", async () => {
  await fixture(async (h) => {
    assert.equal(await h.bridge.resumeFollowup("m1"), false);
    h.entries.push(entry(4, { type: "user_message", messageId: "other" }), entry(5, notification("task-1")), entry(6, answer("a2", "私有答复")));
    assert.equal(await h.bridge.resumeFollowup("m1"), true);
    assert.equal(h.sent.length, 0);
    assert.equal(h.state.job("m1")?.followup, null);
  });
});

test("原会话有新的 IM 消息时停止旧跟踪", async () => {
  await fixture(async (h) => {
    assert.equal(await h.bridge.resumeFollowup("m1"), false);
    h.state.ensureJob("m2", { messageId: "m2", conversationKey: "group:channel:thread", chatId: "channel", senderId: "user", createdAt: 2 });
    h.entries.push(entry(4, notification("task-1")), entry(5, answer("a2", "旧任务")));
    assert.equal(await h.bridge.resumeFollowup("m1"), true);
    assert.equal(h.sent.length, 0);
  });
});

test("重启后发现发送中标记时不盲目重发", async () => {
  await fixture(async (h) => {
    await h.state.mutate((s) => { s.jobs.m1!.followup!.sending = "a2"; });
    assert.equal(await h.bridge.resumeFollowup("m1"), true);
    assert.equal((await h.reopen()).job("m1")?.followup?.uncertain, true);
    assert.equal(h.sent.length, 0);
  });
});

test("发送结果不确定时持久化并停止重试，避免重复", async () => {
  await fixture(async (h) => {
    assert.equal(await h.bridge.resumeFollowup("m1"), false);
    h.entries.push(entry(4, notification("task-1")), entry(5, answer("a2", "最终结果")));
    h.setFail(true);
    assert.equal(await h.bridge.resumeFollowup("m1"), true);
    assert.equal((await h.reopen()).job("m1")?.followup?.uncertain, true);
    h.setFail(false);
    assert.equal(await h.bridge.resumeFollowup("m1"), true);
    assert.equal(h.sent.length, 1);
  });
});

test("同 thread 中途多轮插话时，未完成的后台任务逐轮交接给最新消息并最终回发", async () => {
  await fixture(async (h) => {
    assert.equal(await h.bridge.resumeFollowup("m1"), false);
    assert.deepEqual(h.state.job("m1")?.followup?.pendingTasks, ["task-1"]);

    // 用户中途插话 m2（本身又启动短任务 task-2），继承 m1 的 task-1
    h.setNextReply("已启动修复验证", () => {
      const seq = Math.max(0, ...h.entries.map((e) => e.seqEnd)) + 1;
      h.entries.push(entry(seq, launch("task-2")));
    });
    await h.bridge.handle({
      channel: "slack", connectionId, kind: "group", chatId: "channel", threadId: "thread",
      senderId: "user", senderName: "U", messageId: "m2", timestamp: 2, text: "067 你来解决",
      trigger: { mention: true, replyToBot: false, command: false },
    });
    await h.queue.idle();
    assert.equal(h.state.job("m1")?.followup, null);
    assert.deepEqual(h.state.job("m2")?.followup?.pendingTasks, ["task-1"]);

    // m2 的短任务 task-2 先完成并回发，但长任务 task-1 仍在等待
    const m2DoneSeq = Math.max(0, ...h.entries.map((e) => e.seqEnd));
    h.entries.push(entry(m2DoneSeq + 1, notification("task-2")), entry(m2DoneSeq + 2, answer("a-t2", "067 已修复")));
    assert.equal(await h.bridge.resumeFollowup("m2"), false);
    assert.equal(h.sent.at(-1)?.text, "067 已修复");
    assert.deepEqual(h.state.job("m2")?.followup?.pendingTasks, ["task-1"]);

    // 用户再发 m3（本轮不启动任何新 bg_run），继续继承 task-1
    h.setNextReply("已提交接续构建");
    await h.bridge.handle({
      channel: "slack", connectionId, kind: "group", chatId: "channel", threadId: "thread",
      senderId: "user", senderName: "U", messageId: "m3", timestamp: 3, text: "继续吧",
      trigger: { mention: true, replyToBot: false, command: false },
    });
    await h.queue.idle();
    assert.equal(h.state.job("m2")?.followup, null);
    assert.deepEqual(h.state.job("m3")?.followup?.pendingTasks, ["task-1"]);
    assert.equal(await h.bridge.resumeFollowup("m3"), false);

    // 最初的定时任务 task-1 到期完成，由最新消息 m3 投递回原 thread
    const m3DoneSeq = Math.max(0, ...h.entries.map((e) => e.seqEnd));
    h.entries.push(entry(m3DoneSeq + 1, notification("task-1")), entry(m3DoneSeq + 2, answer("a-t1", "两柜均已结束 SUCCESS")));
    assert.equal(await h.bridge.resumeFollowup("m3"), true);
    assert.equal(h.sent.at(-1)?.text, "两柜均已结束 SUCCESS");
    assert.equal(h.sent.at(-1)?.threadId, "thread");
    assert.equal(h.state.job("m3")?.followup, null);
  });
});

test("首轮尚未执行轮询即收到同 thread 新消息时，交接前自动追平游标提取待完成任务", async () => {
  await fixture(async (h) => {
    // m1 尚未调用过 resumeFollowup("m1")，pendingTasks 仍为空，但 timeline 中已有 launch("task-1")
    assert.deepEqual(h.state.job("m1")?.followup?.pendingTasks, []);
    h.setNextReply("收到新消息");
    await h.bridge.handle({
      channel: "slack", connectionId, kind: "group", chatId: "channel", threadId: "thread",
      senderId: "user", senderName: "U", messageId: "m2", timestamp: 2, text: "补充一句",
      trigger: { mention: true, replyToBot: false, command: false },
    });
    await h.queue.idle();
    assert.equal(h.state.job("m1")?.followup, null);
    assert.deepEqual(h.state.job("m2")?.followup?.pendingTasks, ["task-1"]);

    const lastSeq = Math.max(0, ...h.entries.map((e) => e.seqEnd));
    h.entries.push(entry(lastSeq + 1, notification("task-1")), entry(lastSeq + 2, answer("a-final", "后台最终结果")));
    assert.equal(await h.bridge.resumeFollowup("m2"), true);
    assert.equal(h.sent.at(-1)?.text, "后台最终结果");
  });
});

test("同 thread 发送裸 !m 查询模型不打断前序后台续跑跟踪", async () => {
  await fixture(async (h) => {
    assert.equal(await h.bridge.resumeFollowup("m1"), false);
    await h.bridge.handle({
      channel: "slack", connectionId, kind: "group", chatId: "channel", threadId: "thread",
      senderId: "user", senderName: "U", messageId: "m-cmd", timestamp: 2, text: "!m",
      trigger: { mention: true, replyToBot: false, command: true },
    });
    await h.queue.idle();
    assert.match(h.sent.at(-1)?.text ?? "", /^当前模型：pi\/self-hosted\/model-a$/);
    assert.deepEqual(h.state.job("m1")?.followup?.pendingTasks, ["task-1"]);

    h.entries.push(entry(4, notification("task-1")), entry(5, answer("a2", "查询后仍收到后台结果")));
    assert.equal(await h.bridge.resumeFollowup("m1"), true);
    assert.equal(h.sent.at(-1)?.text, "查询后仍收到后台结果");
  });
});
