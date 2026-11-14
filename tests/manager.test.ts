import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import { Manager } from "../server/manager.ts";
import { listUnarchivedAgents } from "../server/agent-directory.ts";
import { CHANNEL_DEFINITIONS } from "../server/channels/registry.ts";
import type { AdapterContext, ChannelAdapter } from "../server/channels/types.ts";
import { StateStore } from "../server/state-store.ts";
import { connectionSchema, emptyPolicy, type Connection } from "../shared/config.ts";

const config = connectionSchema.parse({
  id: "00000000-0000-4000-8000-000000000001", channel: "slack", name: "test",
  enabled: true, target: null, bindings: {}, policy: emptyPolicy(), revision: 0,
  teamId: "TTEST", botUserId: "UTEST",
}) as Connection;
const agent = (id: string, status = "idle", archivedAt: string | null = null) => ({ id, title: id, status, archivedAt }) as PaseoAgent;
const page = (agents: PaseoAgent[], nextCursor: string | null = null) => ({ entries: agents.map(agent => ({ agent })), pageInfo: { nextCursor } });
const apiFor = (list: (options: any) => Promise<unknown>) => ({ agents: { list } }) as unknown as PaseoApi;

async function fixture(t: TestContext, run: (h: {
  manager: Manager; contexts: AdapterContext[]; state: StateStore;
  setAgents: (agents: PaseoAgent[]) => void; activate: () => Promise<void>;
}) => Promise<void>, start?: (ctx: AdapterContext) => Promise<void>) {
  const manager = new Manager();
  const contexts: AdapterContext[] = [];
  let agents = [agent("live")];
  t.mock.method(manager.registry, "list", () => [config]);
  t.mock.method(manager.secrets, "read", async () => ({}));
  // Never load or write production state/secrets; only use StateStore's empty memory state.
  t.mock.method(StateStore.prototype, "load", async () => {});
  t.mock.method(manager, "daemon", async () => apiFor(async () => page(agents)));
  t.mock.method(CHANNEL_DEFINITIONS.slack, "create", (ctx: AdapterContext): ChannelAdapter => {
    contexts.push(ctx);
    return {
      channel: "slack", capabilities: { progress: "none", markdown: "plain", uploadImage: false, uploadFile: false, reactions: false, typing: false, maxChunkChars: 4000, threads: true },
      async start() { await start?.(ctx); }, async stop() {}, async sendText() { return {}; },
    };
  });
  const internal = manager as unknown as {
    activate(config: Connection): Promise<void>;
    active: Map<string, { state: StateStore; startTask: Promise<void> }>;
  };
  const activate = async () => { await internal.activate(config); await internal.active.get(config.id)!.startTask; };
  try {
    await activate();
    await run({ manager, contexts, state: internal.active.get(config.id)!.state, setAgents: value => { agents = value; }, activate });
  } finally { await manager.stop(); }
}
const view = async (manager: Manager) => (await manager.list()).channels.find(b => b.channel === "slack")!.connections[0]!;

test("manager: reconnect readiness clears the old error on every successful handshake", async t => {
  await fixture(t, async ({ manager, contexts }) => {
    assert.equal((await view(manager)).ready, true);
    for (let i = 0; i < 2; i++) {
      contexts[0]!.onError(new Error("test transport disconnected"));
      assert.equal((await view(manager)).ready, false);
      contexts[0]!.onReady!();
      const current = await view(manager);
      assert.equal(current.ready, true);
      assert.equal(current.running, true);
      assert.equal(current.lastError, null);
    }
  });
});

test("manager: callbacks from replaced or stopped adapters cannot change current status", async t => {
  await fixture(t, async ({ manager, contexts, activate }) => {
    const old = contexts[0]!;
    await activate();
    old.onError(new Error("stale adapter"));
    assert.equal((await view(manager)).ready, true);
    contexts[1]!.onError(new Error("current disconnected"));
    old.onReady!();
    assert.equal((await view(manager)).ready, false);
    await manager.stop();
    contexts[1]!.onReady!();
    assert.equal((await view(manager)).ready, false);
  });
});

test("manager: start completion cannot override a disconnect after the initial hello", async t => {
  await fixture(t, async ({ manager }) => {
    const current = await view(manager);
    assert.equal(current.ready, false);
    assert.equal(current.lastError, "disconnected during start");
  }, async ctx => { ctx.onReady!(); ctx.onError(new Error("disconnected during start")); });
});

test("manager: show only unarchived associations, retaining closed agents and filtering before the 50-row cap", async t => {
  await fixture(t, async ({ manager, state, setAgents }) => {
    setAgents([agent("live"), agent("closed", "closed"), agent("archived", "closed", "2026-01-01")]);
    for (let i = 0; i < 60; i++) state.get().conversations[`old-${i}`] = { agentId: "archived", title: null, workspaceId: null, updatedAt: 100 + i };
    state.get().conversations.live = { agentId: "live", title: null, workspaceId: null, updatedAt: 2 };
    state.get().conversations.closed = { agentId: "closed", title: null, workspaceId: null, updatedAt: 1 };
    state.get().conversations.deleted = { agentId: "missing", title: null, workspaceId: null, updatedAt: 200 };
    state.get().conversations.unbound = { agentId: null, title: null, workspaceId: null, updatedAt: 300 };
    assert.deepEqual((await view(manager)).conversations.map(c => c.key), ["live", "closed"]);
    setAgents([agent("closed", "closed")]);
    assert.deepEqual((await view(manager)).conversations.map(c => c.key), ["closed"]);
    assert.equal(Object.keys(state.get().conversations).length, 64, "display filtering must not delete routing history");
  });
});

test("manager: directory failure never falls back to historical associations", async t => {
  await fixture(t, async ({ manager, state }) => {
    state.get().conversations.old = { agentId: "archived", title: null, workspaceId: null, updatedAt: 1 };
    t.mock.method(manager, "daemon", async () => apiFor(async () => { throw new Error("directory unavailable"); }));
    await assert.rejects(manager.list(), /directory unavailable/);
  });
});

test("agent directory: traverse all pages with explicit unarchived/background filters", async () => {
  const calls: any[] = [];
  const agents = await listUnarchivedAgents(apiFor(async options => {
    calls.push(options);
    return options.page.cursor ? page([agent("closed", "closed")]) : page([agent("live"), agent("archived", "closed", "2026-01-01")], "next");
  }));
  assert.deepEqual(agents.map(a => a.id), ["live", "closed"]);
  assert.deepEqual(calls[0].filter, { includeArchived: false, includeBackground: true });
  assert.equal(calls[1].page.cursor, "next");
  assert.deepEqual(calls[0].sort, [{ key: "created_at", direction: "desc" }]);
});

test("agent directory: failed or cyclic pagination fails closed", async () => {
  await assert.rejects(listUnarchivedAgents(apiFor(async () => page([], "same"))), /repeated cursor/);
  await assert.rejects(listUnarchivedAgents(apiFor(async () => { throw new Error("offline"); })), /offline/);
});
