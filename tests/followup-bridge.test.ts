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

async function fixture(run: (h: { bridge: Bridge; state: StateStore; entries: ReturnType<typeof entry>[]; sent: OutboundText[]; setRunning: (v: boolean) => void; setFail: (v: boolean) => void; reopen: () => Promise<StateStore> }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "im-followup-"));
  const state = new StateStore(connectionId, root);
  const queue = new AgentQueue();
  const entries = [entry(1, { type: "user_message", messageId: identity }), entry(2, launch("task-1"), 4), entry(3, answer("a1", "处理中"))];
  const sent: OutboundText[] = [];
  let running = false;
  let fail = false;
  const adapter: ChannelAdapter = {
    channel: "slack",
    capabilities: { progress: "none", markdown: "plain", uploadImage: false, uploadFile: false, reactions: false, typing: false, maxChunkChars: 4000, threads: true },
    async start() {}, async stop() {},
    async sendText(out) { sent.push(out); if (fail) throw new Error("transport lost after send"); return { messageId: "sent" }; },
  };
  const agent = {
    async refresh() { return { agent: { id: "a1", status: running ? "running" : "idle", activeTurn: running ? {} : null, archivedAt: null } }; },
    timeline: { async refetch({ cursor }: { cursor: { epoch: string; seq: number } }) {
      // Deliberately include overlapping projected entries to exercise cursor logic.
      const rows = entries.filter((e) => e.seqEnd > cursor.seq).slice(0, 2);
      const last = Math.max(cursor.seq, rows.at(-1)?.seqStart ?? cursor.seq);
      return { epoch: "e1", entries: rows, endCursor: { epoch: "e1", seq: last }, hasNewer: entries.some((e) => e.seqStart > last), error: null, reset: false, staleCursor: false, gap: null };
    } },
  };
  const api = { agents: { ref: () => agent } } as unknown as PaseoApi;
  const config = connectionSchema.parse({ id: connectionId, channel: "slack", name: "test", enabled: true, target: null, policy: emptyPolicy(), bindings: {}, revision: 0, teamId: "TTEST", botUserId: "UTEST" }) as Connection;
  const deps: BridgeDeps = { connectionId, config: () => config, adapter: () => adapter, state, queue, daemon: async () => api, settings: async () => imSettings.schema.parse({}), deferred: { track() {}, resolve() {} }, signal: new AbortController().signal, log() {} };
  const bridge = new Bridge(deps, new Router(deps.daemon));
  try {
    await state.load();
    state.ensureJob("m1", { messageId: "m1", conversationKey: "group:channel:thread", chatId: "channel", threadId: "thread", senderId: "user", createdAt: 1, agentId: "a1", dispatch: "sent", after: { epoch: "e1", seq: 0 }, answer: "处理中", delivery: "done", followup: { cursor: { epoch: "e1", seq: 0 }, originSeen: false, pendingTasks: [], waitingForReply: false, candidate: null, lastAnswer: "处理中", sending: null, uncertain: false, expiresAt: Date.now() + 100_000 } });
    await state.mutate((s) => { s.conversations["group:channel:thread"] = { agentId: "a1", workspaceId: null, title: null, updatedAt: Date.now() }; });
    await run({ bridge, state, entries, sent, setRunning: (v) => { running = v; }, setFail: (v) => { fail = v; }, reopen: async () => { await state.drain(); const other = new StateStore(connectionId, root); await other.load(); return other; } });
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
