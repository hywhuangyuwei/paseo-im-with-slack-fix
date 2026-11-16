import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { Bridge, messageIdentity, type BridgeDeps } from "../server/bridge.ts";
import { AgentQueue } from "../server/queue.ts";
import { Router, CONNECTION_LABEL, CONVERSATION_LABEL } from "../server/routing.ts";
import { StateStore } from "../server/state-store.ts";
import { connectionSchema, emptyPolicy } from "../shared/config.ts";
import { imSettings } from "../shared/settings.ts";
import type { NormalizedMessage, OutboundText } from "../shared/model.ts";

const CONNECTION_ID = "00000000-0000-4000-8000-000000000001";
const DEFAULT_MODEL = "gateway/default";
const NEW_MODEL = "gateway/argon";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "paseo-im-model-"));
  const state = new StateStore(CONNECTION_ID, root);
  await state.load();
  const config = connectionSchema.parse({ id: CONNECTION_ID, channel: "slack", name: "Test", enabled: true,
    teamId: "team-test", botUserId: "bot-test",
    target: { kind: "workspace", workspaceId: "ws-1", profile: { provider: `pi/${DEFAULT_MODEL}`, systemPrompt: "" } },
    policy: { ...emptyPolicy(), invocation: "all", directMessages: "everyone" }, bindings: {}, revision: 0,
  });
  const queue = new AgentQueue();
  const sent: OutboundText[] = [];
  const events: string[] = [];
  const deferred: string[] = [];
  const agents = new Map<string, ReturnType<typeof makeAgent>>();
  let createCount = 0;
  let failSwitch = false;
  let confirmSwitch = true;
  let failReceipt = false;
  function makeAgent(id: string, labels: Record<string, string> = {}, model = DEFAULT_MODEL) {
    const snapshot = { id, provider: "pi", labels, status: "idle", archivedAt: null, activeTurn: false,
      workspaceId: "ws-1", cwd: "/workspace", runtimeInfo: { model }, pendingPermissions: null };
    const entries: { seqStart: number; seqEnd: number; item: { type: string; messageId: string } }[] = [];
    return {
      id, snapshot, entries,
      refresh: async () => ({ agent: snapshot }),
      send: async (text: string, options: { messageId: string }) => {
        events.push(`send:${id}:${snapshot.runtimeInfo.model}:${text}`);
        entries.push({ seqStart: entries.length + 1, seqEnd: entries.length + 1, item: { type: "user_message", messageId: options.messageId } });
      },
      waitForFinish: async () => ({ status: "idle", final: null, error: null, lastMessage: `answer:${id}:${snapshot.runtimeInfo.model}` }),
      timeline: { refetch: async () => ({ epoch: "epoch-1", entries }) },
    };
  }
  const api = {
    providers: { snapshot: async () => ({ entries: [{ provider: "pi", models: [
      { id: DEFAULT_MODEL, label: "Default" }, { id: NEW_MODEL, label: "Argon" },
      { id: "cloud/sol-a", label: "Sol A" }, { id: "cloud/sol-b", label: "Sol B" },
    ] }] }) },
    agents: { ref: (id: string) => { const agent = agents.get(id); assert.ok(agent, `missing ${id}`); return agent; } },
    workspaces: { ref: () => ({ refresh: async () => ({ workspaceDirectory: "/workspace" }),
      agents: { create: async (payload: { config: { provider: string }; labels: Record<string, string> }) => {
        const id = `agent-${++createCount}`;
        const agent = makeAgent(id, payload.labels, payload.config.provider.slice(3));
        agents.set(id, agent);
        return agent;
      } },
    }) },
  } as unknown as PaseoApi;
  const deps: BridgeDeps = {
    connectionId: CONNECTION_ID, config: () => config, state, queue, daemon: async () => api,
    setAgentModel: async (id, model) => {
      events.push(`model:${id}:${model}`);
      if (failSwitch) throw new Error("switch rejected");
      if (confirmSwitch) agents.get(id)!.snapshot.runtimeInfo.model = model;
    },
    adapter: () => ({ channel: "slack", capabilities: { progress: "none", markdown: "plain", uploadImage: false,
      uploadFile: false, reactions: false, typing: false, maxChunkChars: 4000, threads: true },
      sendText: async (out) => {
        if (failReceipt && out.text.startsWith("✅")) throw new Error("receipt failed");
        sent.push(out); events.push(`receipt:${out.text}`); return { messageId: `out-${sent.length}` };
      }, start: async () => {}, stop: async () => {},
    }),
    settings: async () => imSettings.schema.parse({}),
    deferred: { track: (id) => deferred.push(id), resolve: () => {} },
    signal: new AbortController().signal, log: () => {},
  };
  const bridge = new Bridge(deps, new Router(deps.daemon));
  t.after(async () => { await queue.idle(); await state.drain(); await rm(root, { recursive: true, force: true }); });
  const message = (id: string, text: string, threadId = "thread-1"): NormalizedMessage => ({
    channel: "slack", connectionId: CONNECTION_ID, kind: "dm", chatId: "chat-1", threadId, senderId: "user-1",
    messageId: id, timestamp: Date.now(), text, trigger: { mention: true, replyToBot: false, command: text.startsWith("!m") },
  });
  const send = async (id: string, text: string, threadId?: string) => { await bridge.handle(message(id, text, threadId)); await queue.idle(); };
  return { bridge, deps, state, queue, sent, events, agents, config, root, deferred, message, send,
    failSwitch: () => { failSwitch = true; }, badConfirmation: () => { confirmSwitch = false; },
    failReceipt: () => { failReceipt = true; } };
}

test("first-thread !m strips command, confirms before body, persists model only on this agent", async (t) => {
  const h = await fixture(t);
  await h.send("m1", "!m argon\nMESSAGE");
  assert.equal(h.events[0], `model:agent-1:${NEW_MODEL}`);
  assert.match(h.events[1]!, /^receipt:✅/);
  assert.equal(h.events[2], `send:agent-1:${NEW_MODEL}:MESSAGE`);
  assert.ok(h.sent.every((out) => out.threadId === "thread-1"));
  assert.equal(h.state.job("m1")?.modelChange?.applied, true);
  await h.send("m2", "next");
  assert.ok(h.events.includes(`send:agent-1:${NEW_MODEL}:next`));
  await h.send("m3", "new", "thread-2");
  assert.ok(h.events.includes(`send:agent-2:${DEFAULT_MODEL}:new`));
  assert.equal(h.config.target?.kind === "workspace" && h.config.target.profile.provider, `pi/${DEFAULT_MODEL}`);
});

test("command-only on first or later message switches without prompt or wait and dedupes", async (t) => {
  const h = await fixture(t);
  await h.send("m1", "!m argon");
  assert.equal(h.events.filter((event) => event.startsWith("send:")).length, 0);
  assert.equal(h.state.job("m1")?.dispatch, null);
  assert.equal(h.state.job("m1")?.delivery, "done");
  assert.equal(h.state.job("m1")?.followup, null);
  await h.send("m1", "!m argon");
  assert.equal(h.sent.length, 1);
  await h.send("m2", "!m sol a");
  assert.equal(h.agents.get("agent-1")!.snapshot.runtimeInfo.model, "cloud/sol-a");
  await h.send("m3", "continue");
  assert.ok(h.events.includes("send:agent-1:cloud/sol-a:continue"));
});

test("ambiguous, absent, or empty query has readable error and never sends body/creates agent", async (t) => {
  const h = await fixture(t);
  for (const [id, text, error] of [["m1", "!m sol\nbody", /匹配到 2 个/], ["m2", "!m nope\nbody", /没有找到匹配/], ["m3", "!m\nbody", /用法/]] as const) {
    await h.send(id, text);
    assert.match(h.sent.at(-1)!.text, error);
  }
  assert.equal(h.agents.size, 0);
  assert.equal(h.events.some((event) => event.startsWith("model:") || event.startsWith("send:")), false);
});

test("non-Pi route or actual non-Pi agent refuses without switching/body", async (t) => {
  const h = await fixture(t);
  assert.equal(h.config.target?.kind, "workspace");
  if (h.config.target?.kind !== "workspace") return;
  h.config.target.profile.provider = "codex/model";
  await h.send("m1", "!m argon\nbody");
  assert.match(h.sent.at(-1)!.text, /只支持 Pi/);
  assert.equal(h.agents.size, 0);
  h.config.target.profile.provider = `pi/${DEFAULT_MODEL}`;
  await h.send("m2", "first");
  h.agents.get("agent-1")!.snapshot.provider = "codex";
  await h.send("m3", "!m argon\nbody");
  assert.match(h.sent.at(-1)!.text, /只支持 Pi/);
  assert.equal(h.events.some((event) => event.startsWith("model:")), false);
});

test("fixed/shared agent routes refuse !m to protect other threads", async (t) => {
  const h = await fixture(t);
  h.config.target = { kind: "agent", agentId: "shared", sharedHistory: true };
  await h.send("m1", "!m argon\nbody");
  assert.match(h.sent.at(-1)!.text, /已有\/共享聊天/);
  assert.equal(h.agents.size, 0);
});

test("foreign ownership or duplicate binding refuses even on a workspace route", async (t) => {
  const h = await fixture(t);
  await h.send("m1", "first");
  const agent = h.agents.get("agent-1")!;
  agent.snapshot.labels[CONNECTION_LABEL] = "other-connection";
  await h.send("m2", "!m argon\nbody");
  assert.match(h.sent.at(-1)!.text, /不是本 thread 独占/);
  agent.snapshot.labels[CONNECTION_LABEL] = CONNECTION_ID;
  assert.equal(agent.snapshot.labels[CONVERSATION_LABEL], "dm:chat-1:thread-1");
  await h.state.mutate((draft) => { draft.conversations.other = { title: null, agentId: "agent-1", workspaceId: "ws-1", updatedAt: Date.now() }; });
  await h.send("m3", "!m argon\nbody");
  assert.match(h.sent.at(-1)!.text, /不是本 thread 独占/);
  assert.equal(h.events.some((event) => event.startsWith("model:")), false);
});

test("switch rejection or failed read-back never executes body or claims success", async (t) => {
  const h = await fixture(t);
  h.failSwitch();
  await h.send("m1", "!m argon\nbody");
  assert.match(h.sent.at(-1)!.text, /模型切换失败，正文未发送/);
  assert.equal(h.sent.some((out) => out.text.startsWith("✅")), false);
  assert.equal(h.events.some((event) => event.startsWith("send:")), false);
  const other = await fixture(t);
  other.badConfirmation();
  await other.send("m1", "!m argon\nbody");
  assert.match(other.sent.at(-1)!.text, /切换未能确认/);
  assert.equal(other.events.some((event) => event.startsWith("send:")), false);
});

test("failed receipt stops body, successful application remains durable", async (t) => {
  const h = await fixture(t);
  h.failReceipt();
  await h.send("m1", "!m argon\nbody");
  assert.equal(h.state.job("m1")?.modelChange?.applied, true);
  assert.equal(h.state.job("m1")?.modelChange?.notified, false);
  assert.equal(h.events.some((event) => event.startsWith("send:")), false);
});

test("queued switches and subsequent messages stay in arrival order", async (t) => {
  const h = await fixture(t);
  await h.bridge.handle(h.message("m1", "!m argon\none"));
  await h.bridge.handle(h.message("m2", "!m sol a\ntwo"));
  await h.bridge.handle(h.message("m3", "three"));
  await h.queue.idle();
  assert.deepEqual(h.events.filter((event) => event.startsWith("send:")), [
    `send:agent-1:${NEW_MODEL}:one`, "send:agent-1:cloud/sol-a:two", "send:agent-1:cloud/sol-a:three",
  ]);
});

test("!m replies are control input, not pending question answers", async (t) => {
  const h = await fixture(t);
  await h.send("m1", "first");
  h.state.updateJob("m1", { question: { requestId: "q1", fields: [{ header: "Choice", text: "?", options: ["A"] }],
    messageId: "question-out", notified: true, status: "pending" } });
  await h.bridge.handle({ ...h.message("m2", "!m argon"), replyTo: { id: "question-out" } });
  await h.queue.idle();
  assert.equal(h.state.job("m2")?.questionReply, null);
  assert.equal(h.state.job("m2")?.modelChange?.applied, true);
});

test("unauthorized !m never queries or switches", async (t) => {
  const h = await fixture(t);
  h.config.policy.directMessages = "operators";
  await h.send("m1", "!m argon\nbody");
  assert.equal(h.agents.size, 0);
  assert.equal(h.state.job("m1"), undefined);
});

test("reload recovery preserves applied command-only model and does not send a prompt", async (t) => {
  const h = await fixture(t);
  await h.send("m1", "!m argon");
  h.state.updateJob("m1", { delivery: null, answer: null });
  await h.state.drain();
  await h.state.load();
  const modelEvents = h.events.filter((event) => event.startsWith("model:")).length;
  await h.bridge.rerunQueued("m1");
  assert.equal(h.events.filter((event) => event.startsWith("model:")).length, modelEvents);
  assert.equal(h.events.some((event) => event.startsWith("send:")), false);
  assert.equal(h.state.job("m1")?.delivery, "done");
});

test("reload with dispatched identity does not repeat an old switch or body", async (t) => {
  const h = await fixture(t);
  await h.send("m1", "!m argon\nbody");
  const agent = h.agents.get("agent-1")!;
  assert.equal(agent.entries[0]!.item.messageId, messageIdentity(CONNECTION_ID, "m1"));
  h.state.updateJob("m1", { dispatch: "sending", delivery: null, answer: null, modelChange: { modelId: NEW_MODEL, applied: false, notified: false } });
  agent.snapshot.runtimeInfo.model = "cloud/sol-a";
  const before = h.events.filter((event) => event.startsWith("model:") || event.startsWith("send:"));
  await h.bridge.rerunQueued("m1");
  assert.deepEqual(h.events.filter((event) => event.startsWith("model:") || event.startsWith("send:")), before);
});

test("deferred command does not deliver unrelated prior-turn result", async (t) => {
  const h = await fixture(t);
  await h.send("m1", "first");
  const agent = h.agents.get("agent-1")!;
  const gate = Promise.withResolvers<{ status: string; final: null; error: null; lastMessage: string }>();
  const entered = Promise.withResolvers<void>();
  agent.snapshot.activeTurn = true;
  agent.waitForFinish = () => { entered.resolve(); return gate.promise; };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await h.bridge.handle(h.message("m2", "!m argon"));
  await entered.promise;
  t.mock.timers.tick(31 * 60_000);
  // The timeout handler sends its notice and registers the deferred job.
  await h.queue.run("conversation:dm:chat-1:thread-1", async () => {});
  assert.deepEqual(h.deferred, ["m2"]);
  assert.equal(await h.bridge.resumeDeferred("m2"), false);
  const count = h.sent.length;
  agent.snapshot.activeTurn = false;
  gate.resolve({ status: "idle", final: null, error: null, lastMessage: "unrelated previous answer" });
  await h.queue.idle();
  assert.equal(await h.bridge.resumeDeferred("m2"), true);
  assert.equal(h.sent.length, count + 1);
  assert.match(h.sent.at(-1)!.text, /^✅/);
  assert.equal(h.sent.some((out) => out.text === "unrelated previous answer"), false);
  t.mock.timers.reset();
});

test("slow catalog before agent binding also retains deferred command receipt", async (t) => {
  const h = await fixture(t);
  const api = await h.deps.daemon();
  const original = api.providers.snapshot;
  const catalog = await original();
  const gate = Promise.withResolvers<typeof catalog>();
  const entered = Promise.withResolvers<void>();
  api.providers.snapshot = () => { entered.resolve(); return gate.promise; };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await h.bridge.handle(h.message("m1", "!m argon"));
  await entered.promise;
  t.mock.timers.tick(31 * 60_000);
  await h.queue.run("conversation:dm:chat-1:thread-1", async () => {});
  assert.equal(h.state.job("m1")?.agentId, null);
  assert.equal(await h.bridge.resumeDeferred("m1"), false);
  gate.resolve(catalog);
  // Catalog resolution happens outside the agent queue, so wait for the stored
  // result, using the actual application promise rather than timer polling.
  const complete = Promise.withResolvers<void>();
  const update = h.state.updateJob.bind(h.state);
  h.state.updateJob = (id, patch) => { const value = update(id, patch); if (id === "m1" && patch.answer) complete.resolve(); return value; };
  await complete.promise;
  await h.queue.idle();
  assert.equal(await h.bridge.resumeDeferred("m1"), true);
  assert.match(h.sent.at(-1)!.text, /^✅/);
  t.mock.timers.reset();
});

test("deferred switch rejection is delivered and remains recoverable after reload", async (t) => {
  const h = await fixture(t);
  await h.send("m1", "first");
  const agent = h.agents.get("agent-1")!;
  const gate = Promise.withResolvers<{ status: string; final: null; error: null; lastMessage: string }>();
  const entered = Promise.withResolvers<void>();
  agent.snapshot.activeTurn = true;
  agent.waitForFinish = () => { entered.resolve(); return gate.promise; };
  h.failSwitch();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await h.bridge.handle(h.message("m2", "!m argon\nbody"));
  await entered.promise;
  t.mock.timers.tick(31 * 60_000);
  await h.queue.run("conversation:dm:chat-1:thread-1", async () => {});
  agent.snapshot.activeTurn = false;
  gate.resolve({ status: "idle", final: null, error: null, lastMessage: "previous" });
  await h.queue.idle();
  await h.state.drain();
  await h.state.load();
  assert.equal(h.state.job("m2")?.failure, null);
  assert.match(h.state.job("m2")!.answer!, /模型切换失败，正文未发送/);
  await h.bridge.rerunQueued("m2");
  assert.match(h.sent.at(-1)!.text, /模型切换失败，正文未发送/);
  assert.equal(h.events.some((event) => event.endsWith(":body")), false);
  t.mock.timers.reset();
});
