import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { Connection, Target } from "../shared/config.ts";
import { connectionSchema, emptyPolicy } from "../shared/config.ts";
import { UserFacingError } from "../shared/errors.ts";
import type { ConnectionView } from "../shared/contracts.ts";
import { CHANNEL_SPECS } from "../shared/channels.ts";
import { CHANNEL_IDS, type ChannelId } from "../shared/model.ts";
import { imSettings, type ImSettings } from "../shared/settings.ts";
import { Bridge } from "./bridge.ts";
import { connectLocalDaemon, type DaemonConnection } from "./daemon.ts";
import { DeferredRegistry } from "./deferred.ts";
import { sleep } from "./files.ts";
import type { AdapterContext, ChannelAdapter, ChannelDefinition, PairingSession } from "./channels/types.ts";
import { AgentQueue } from "./queue.ts";
import { Registry } from "./registry.ts";
import { SecretStore } from "./secret-store.ts";
import { migrateBindingTargets, Router } from "./routing.ts";
import { StateStore } from "./state-store.ts";
import { CHANNEL_DEFINITIONS } from "./channels/registry.ts";
import { mapProviderChoices } from "./choices.ts";
import { listUnarchivedAgents } from "./agent-directory.ts";
import { connectionRoot, dataRoot } from "./paths.ts";

export interface ConnectInput {
  channel: ChannelId;
  name: string;
  fields: Record<string, string>;
}

interface ActiveConnection {
  adapter: ChannelAdapter;
  bridge: Bridge;
  state: StateStore;
  followups: DeferredRegistry;
  startTask: Promise<void>;
}

interface PairingAttempt {
  channel: ChannelId;
  connectionId: string;
  session: PairingSession;
  expiresAt: number;
}

const pairingTtlMs = 30 * 60_000;

/** Owns the plugin lifetime: registry, daemon link, per-connection adapters and
 * bridges, pairing attempts, and the RPC surface consumed by the client. */
export class Manager {
  readonly registry = new Registry();
  readonly secrets = new SecretStore();
  private readonly active = new Map<string, ActiveConnection>();
  private readonly attempts = new Map<string, PairingAttempt>();
  private readonly errors = new Map<string, string>();
  private readonly ready = new Set<string>();
  private readonly queue = new AgentQueue();
  private readonly controller = new AbortController();
  private readonly deferred: DeferredRegistry;
  private daemonConnection: DaemonConnection | null = null;
  private daemonPromise: Promise<PaseoApi> | null = null;
  private readSettings: () => Promise<ImSettings> = async () => imSettings.schema.parse({});

  readonly home: string;
  readonly root: string;

  constructor(home: string = process.env.PASEO_HOME || "", root: string = dataRoot) {
    this.home = home;
    this.root = root;
    this.deferred = new DeferredRegistry({
      sweep: (jobId) => this.sweepDeferred(jobId),
      intervalMs: 60_000,
    });
  }

  setSettingsReader(read: () => Promise<ImSettings>): void {
    this.readSettings = read;
  }

  private makeLogger(connection: Connection): (level: "info" | "warn" | "error", message: string) => void {
    return (level, message) =>
      console[level === "info" ? "log" : level](`[paseo-im ${connection.channel}/${connection.name}] ${message}`);
  }

  settings(): Promise<ImSettings> {
    return this.readSettings();
  }

  start(): void {
    void this.run();
  }

  private async run(): Promise<void> {
    await this.registry.load();
    for (const connection of this.registry.list()) {
      if (connection.enabled) void this.activate(connection).catch(() => {});
    }
  }

  async stop(): Promise<void> {
    this.controller.abort();
    this.deferred.stop();
    for (const attempt of this.attempts.values()) await attempt.session.stop().catch(() => {});
    this.attempts.clear();
    for (const id of [...this.active.keys()]) await this.deactivate(id).catch(() => {});
    await this.daemonConnection?.close().catch(() => {});
    this.daemonConnection = null;
    this.daemonPromise = null;
  }

  /** Bounded retry; RPCs and dispatches await this same promise. */
  daemon(): Promise<PaseoApi> {
    if (!this.daemonPromise) {
      this.daemonPromise = this.connectDaemon();
    }
    return this.daemonPromise;
  }

  private async connectDaemon(): Promise<PaseoApi> {
    const home = this.home || process.env.PASEO_HOME || "";
    const deadline = Date.now() + 60_000;
    let lastError: Error | null = null;
    while (!this.controller.signal.aborted && Date.now() < deadline) {
      try {
        this.daemonConnection = await connectLocalDaemon(home);
        return this.daemonConnection.api;
      } catch (error) {
        lastError = error as Error;
        await sleep(5000, this.controller.signal).catch(() => {
          throw new UserFacingError("插件正在停止，无法连接本地 Paseo daemon。");
        });
      }
    }
    this.daemonPromise = null;
    throw new UserFacingError(`无法连接本地 Paseo daemon：${lastError?.message ?? "超时"}`);
  }

  private definition(channel: ChannelId): ChannelDefinition {
    const definition = CHANNEL_DEFINITIONS[channel];
    if (!definition) throw new UserFacingError(`未实现的渠道：${channel}`);
    return definition;
  }

  async connect(input: ConnectInput): Promise<{ id: string; detail: string | null }> {
    const definition = this.definition(input.channel);
    definition.checkPlatform?.();
    const configured = definition.configure(input.fields);
    const candidate = {
      id: randomUUID(),
      channel: input.channel,
      name: input.name,
      enabled: true,
      target: null,
      policy: emptyPolicy(),
      bindings: {},
      revision: 0,
      ...configured.config,
    };
    const connection = connectionSchema.parse(candidate) as Connection;
    await this.registry.add(connection);
    await this.secrets.write(connection.id, configured.secrets);
    if (connection.enabled) {
      void this.activate(connection).catch(() => {});
    }
    return { id: connection.id, detail: null };
  }

  async save(input: {
    id: string;
    revision: number;
    name?: string;
    enabled?: boolean;
    target?: Connection["target"];
    bindings?: Record<string, Target>;
    policy?: Connection["policy"];
  }): Promise<{ connection: Connection }> {
    const current = this.registry.get(input.id);
    if (!current) throw new UserFacingError("连接不存在。");
    const next = connectionSchema.parse({
      ...current,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.target !== undefined ? { target: input.target } : {}),
      ...(input.bindings !== undefined ? { bindings: input.bindings } : {}),
      ...(input.policy !== undefined ? { policy: input.policy } : {}),
      revision: input.revision,
    }) as Connection;
    // 显式保存去向时，把会话级绑定整体对齐 routing 期望值（bindings[key] ?? target）：
    // 1) 跟随旧 agent 的绑定随 target 迁移/解除；2) 历史漂移绑定（改 target 前遗留）
    // 一次性矫正。否则 conversations[key].agentId 只要旧 agent 活着就永远压过新
    // target，出现「改了新对话去向、消息仍进旧 agent」。
    const previousAgent = current.target?.kind === "agent" ? current.target.agentId : null;
    const nextAgent = next.target?.kind === "agent" ? next.target.agentId : null;
    if (input.target !== undefined && previousAgent && previousAgent !== nextAgent) {
      next.bindings = migrateBindingTargets(next.bindings, previousAgent, next.target);
    }
    const saved = await this.registry.replace(next);
    if (input.target !== undefined) {
      const expectedAgent = (key: string): string | null => {
        const explicit = saved.bindings[key];
        if (explicit?.kind === "agent") return explicit.agentId;
        return saved.target?.kind === "agent" ? saved.target.agentId : null;
      };
      // 必须优先改写运行中 bridge 持有的同一个 StateStore 实例：独立实例只写盘，
      // 会被内存态的下一次 mutate 覆盖回去（绑定回滚复发）。
      const live = this.active.get(saved.id);
      let state = live?.state;
      if (!state) {
        state = new StateStore(saved.id);
        await state.load();
      }
      await state.mutate((draft) => {
        for (const [key, conversation] of Object.entries(draft.conversations)) {
          const expected = expectedAgent(key);
          if (conversation.agentId !== expected) conversation.agentId = expected;
        }
      });
    }
    const entry = this.active.get(saved.id);
    if (saved.enabled && !entry) {
      void this.activate(saved).catch(() => {});
    } else if (!saved.enabled && entry) {
      await this.deactivate(saved.id);
    }
    return { connection: saved };
  }

  async disconnect(id: string): Promise<{ removed: boolean }> {
    await this.deactivate(id).catch(() => {});
    const removed = await this.registry.remove(id);
    await this.secrets.remove(id);
    if (removed) {
      await rm(connectionRoot(id), { recursive: true, force: true }).catch(() => {});
      this.errors.delete(id);
      this.ready.delete(id);
    }
    return { removed };
  }

  async revoke(id: string, chatId: string): Promise<{ revoked: boolean }> {
    const state = this.active.get(id)?.state;
    if (!state) return { revoked: false };
    await state.mutate((draft) => {
      delete draft.groups[chatId];
    });
    await this.registry.mutate(id, (entry) => ({
      ...entry,
      bindings: Object.fromEntries(
        Object.entries(entry.bindings).filter(([key]) => key !== chatId && !key.includes(`:${chatId}`)),
      ),
    }) as Connection);
    await this.active.get(id)?.adapter.leaveChat?.(chatId).catch(() => {});
    return { revoked: true };
  }

  async review(id: string, chatId: string, approve: boolean): Promise<{ approved: boolean }> {
    const state = this.active.get(id)?.state;
    if (!state) throw new UserFacingError("连接未运行，无法审批。");
    const pending = state.get().pendingGroups[chatId];
    if (!pending) return { approved: false };
    await state.mutate((draft) => {
      delete draft.pendingGroups[chatId];
      if (approve) draft.groups[chatId] = pending;
    });
    if (!approve) {
      await this.active.get(id)?.adapter.leaveChat?.(chatId).catch(() => {});
    }
    return { approved: approve };
  }

  async pairingStart(channel: ChannelId, connectionId?: string): Promise<{ attemptId: string }> {
    const definition = this.definition(channel);
    let connection: Connection;
    if (connectionId) {
      const existing = this.registry.get(connectionId);
      if (!existing || existing.channel !== channel) throw new UserFacingError("连接不存在或渠道不匹配。");
      connection = existing;
      // 配对会话与运行中的适配器会为同一连接各起一条 socket，竞写同一 auth
      // 目录（WhatsApp 凭据文件会被双写损坏）。重新配对已启用的连接前先停用；
      // 配对成功后 pairingPoll 会 activate 重新拉起。
      if (existing.enabled && this.active.has(existing.id)) {
        await this.deactivate(existing.id);
      }
    } else {
      // 重复点击「扫码配对」会反复自动建连接：复用最近一条仅由配对自动创建的孤儿
      // 连接（未启用、无去向、无凭据），避免渠道列表堆积「XX 配对」僵尸行。
      const orphan = [...this.registry.list()]
        .reverse()
        .find((entry) => entry.channel === channel && !entry.enabled && entry.target === null);
      if (orphan && !(await this.secrets.read(orphan.id))) {
        connection = orphan;
      } else {
        const created = connectionSchema.parse({
          id: randomUUID(),
          channel,
          name: `${CHANNEL_SPECS[channel].title} 配对`,
          enabled: false,
          target: null,
          policy: emptyPolicy(),
          bindings: {},
          revision: 0,
        }) as Connection;
        await this.registry.add(created);
        connection = created;
      }
    }
    definition.checkPlatform?.();
    const attemptId = randomUUID().replace(/-/g, "").slice(0, 24);
    const session = definition.pairing?.(connection.id, connectionRoot(connection.id));
    if (!session) throw new UserFacingError("该渠道无需扫码配对，请直接填写凭据。");
    await session.start();
    this.attempts.set(attemptId, {
      channel,
      connectionId: connection.id,
      session,
      expiresAt: Date.now() + pairingTtlMs,
    });
    return { attemptId };
  }

  async pairingPoll(attemptId: string): Promise<{
    status: "pending" | "scanned" | "ok" | "expired" | "failed";
    qrDataUrl?: string;
    detail?: string | null;
    connectionId?: string;
  }> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) return { status: "expired", detail: "配对会话不存在或已失效，请重新发起。" };
    if (Date.now() > attempt.expiresAt) {
      await attempt.session.stop().catch(() => {});
      this.attempts.delete(attemptId);
      return { status: "expired" };
    }
    const status = await attempt.session.poll();
    if (status.status === "ok") {
      const definition = this.definition(attempt.channel);
      const configured = definition.configure(status.fields);
      const current = this.registry.get(attempt.connectionId);
      if (current) {
        const next = connectionSchema.parse({ ...current, ...configured.config, enabled: true }) as Connection;
        await this.registry.replace({ ...next, revision: next.revision }).catch(async () => {
          await this.registry.mutate(current.id, (entry) => ({ ...entry, ...configured.config } as Connection));
        });
        await this.secrets.merge(current.id, configured.secrets);
        await this.activate(next).catch(() => {});
      }
      this.attempts.delete(attemptId);
      return { status: "ok", connectionId: attempt.connectionId, detail: status.detail ?? null };
    }
    if (status.status === "failed") {
      this.attempts.delete(attemptId);
      return { status: "failed", detail: status.detail };
    }
    if (status.status === "expired") return { status: "expired" };
    if (status.status === "scanned") return { status: "scanned" };
    return { status: "pending", qrDataUrl: status.qrDataUrl, detail: status.detail ?? null };
  }

  async test(id: string): Promise<{ ok: boolean; detail: string | null }> {
    const connection = this.registry.get(id);
    if (!connection) throw new UserFacingError("连接不存在。");
    let entry = this.active.get(id);
    if (!entry) {
      if (!connection.enabled) throw new UserFacingError("连接已停用，请先启用后再测试。");
      await this.activate(connection);
      entry = this.active.get(id);
      if (!entry) throw new UserFacingError("连接启动失败，请查看错误信息。");
      await entry.startTask.catch(() => {});
    }
    if (!entry.adapter.testConnection) {
      return { ok: this.ready.has(id), detail: this.errors.get(id) ?? null };
    }
    const result = await entry.adapter.testConnection();
    return { ok: result.ok, detail: result.detail ?? null };
  }

  private async activate(connection: Connection): Promise<void> {
    await this.deactivate(connection.id).catch(() => {});
    const definition = this.definition(connection.channel);
    definition.checkPlatform?.();
    const state = new StateStore(connection.id);
    await state.load();
    const secrets = (await this.secrets.read(connection.id)) ?? {};
    let adapter: ChannelAdapter | null = null;
    let bridge!: Bridge;
    let lastFollowupError = 0;
    const followups = new DeferredRegistry({
      intervalMs: 5_000,
      sweep: async (id) => {
        try {
          return await bridge.resumeFollowup(id);
        } catch (error) {
          if (this.controller.signal.aborted) return true;
          if (Date.now() - lastFollowupError >= 60_000) {
            lastFollowupError = Date.now();
            this.makeLogger(connection)("warn", `后台续跑检查失败，稍后重试：${(error as Error).message}`);
          }
          return false;
        }
      },
    });
    bridge = new Bridge(
      {
        connectionId: connection.id,
        config: () => this.registry.get(connection.id) ?? connection,
        adapter: () => {
          if (!adapter) throw new UserFacingError("适配器尚未就绪。");
          return adapter;
        },
        state,
        queue: this.queue,
        daemon: () => this.daemon(),
        setAgentModel: async (agentId, modelId) => {
          await this.daemon();
          if (!this.daemonConnection) throw new UserFacingError("本地 Paseo daemon 尚未就绪。");
          await this.daemonConnection.setAgentModel(agentId, modelId);
        },
        settings: () => this.settings(),
        deferred: { track: (id) => this.deferred.track(id), resolve: (id) => this.deferred.resolve(id) },
        followups: { track: (id) => followups.track(id) },
        signal: this.controller.signal,
        log: (level, message) =>
          console[level === "info" ? "log" : level](`[paseo-im ${connection.channel}/${connection.name}] ${message}`),
      },
      new Router(() => this.daemon(), this.makeLogger(connection)),
    );
    let reportsReadiness = false;
    const isCurrent = () => !this.controller.signal.aborted && this.active.get(connection.id)?.adapter === adapter;
    const context: AdapterContext = {
      connectionId: connection.id,
      config: connection,
      secrets,
      dataDir: connectionRoot(connection.id),
      mediaDir: join(connectionRoot(connection.id), "media"),
      signal: this.controller.signal,
      settings: () => this.settings(),
      log: (level, message) =>
        console[level === "info" ? "log" : level](`[paseo-im ${connection.channel}/${connection.name}] ${message}`),
      onMessage: (message) => {
        void bridge.handle(message).catch((error) => {
          console.error(`[paseo-im ${connection.channel}] 处理消息失败：${(error as Error).message}`);
        });
      },
      onGroups: (events) => void this.onGroupEvents(connection.id, events),
      onReady: () => {
        if (!isCurrent()) return;
        reportsReadiness = true;
        this.ready.add(connection.id);
        this.errors.delete(connection.id);
      },
      onError: (error) => {
        if (!isCurrent()) return;
        this.errors.set(connection.id, error.message);
        this.ready.delete(connection.id);
        console.error(`[paseo-im ${connection.channel}/${connection.name}] ${error.message}`);
      },
      updateConfig: async (fields) => {
        await this.registry.mutate(connection.id, (entry) => ({ ...entry, ...fields }) as Connection);
      },
    };
    adapter = definition.create(context);
    const entry: ActiveConnection = { adapter, bridge, state, followups, startTask: Promise.resolve() };
    this.active.set(connection.id, entry);
    this.resumeOrphanJobs(connection, entry);
    entry.startTask = adapter
      .start()
      .then(() => {
        if (!isCurrent()) return;
        // Legacy adapters report initial readiness through start(); adapters
        // with onReady own their status, including close-before-start races.
        if (!reportsReadiness) {
          this.ready.add(connection.id);
          this.errors.delete(connection.id);
        }
        for (const job of Object.values(state.get().jobs)) {
          if (job.delivery === "done" && job.followup && !job.followup.uncertain) followups.track(job.messageId);
        }
      })
      .catch((error) => {
        if (!isCurrent()) return;
        this.errors.set(connection.id, (error as Error).message);
        this.ready.delete(connection.id);
        console.error(`[paseo-im ${connection.channel}/${connection.name}] 启动失败：${(error as Error).message}`);
      });
  }

  /** A plugin reload kills in-flight reply waiters AND queued pipeline steps
   * (deliver's catch skips failure-marking on abort), freezing jobs at
   * delivery=null with dispatch null/sending/sent. Resumed here, newest per
   * conversation, via the full deliver pipeline. Runs before adapter.start,
   * so no new-message waiter can overlap yet. */
  private resumeOrphanJobs(connection: Connection, entry: ActiveConnection): void {
    const orphans = entry.state.resumableJobs();
    if (!orphans.length) return;
    console.log(`[paseo-im ${connection.channel}/${connection.name}] 恢复 ${orphans.length} 条中断的在途回复。`);
    for (const job of orphans) {
      void entry.bridge.rerunQueued(job.messageId).catch((error) => {
        console.error(`[paseo-im ${connection.channel}/${connection.name}] 恢复失败（${job.messageId}）：${(error as Error).message}`);
      });
    }
  }

  private async deactivate(id: string): Promise<void> {
    const entry = this.active.get(id);
    if (!entry) return;
    this.active.delete(id);
    this.ready.delete(id);
    entry.followups.stop();
    await entry.adapter.stop().catch(() => {});
    // adapter 停止后再排空写链：调用方（manager.stop/重载/测试清理）随后才可
    // 安全删除数据目录，同时避免重载截断最后一次 updateJob 持久化。
    await entry.state.drain().catch(() => {});
    await entry.startTask.catch(() => {});
  }

  private async onGroupEvents(connectionId: string, events: { chatId: string; title?: string; added: boolean }[]): Promise<void> {
    const connection = this.registry.get(connectionId);
    const state = this.active.get(connectionId)?.state;
    if (!connection || !state) return;
    const admission = connection.policy.groupAdmission;
    await state.mutate((draft) => {
      for (const event of events) {
        if (!event.added) {
          delete draft.groups[event.chatId];
          delete draft.pendingGroups[event.chatId];
          continue;
        }
        if (admission === "everyone") {
          draft.groups[event.chatId] = { title: event.title ?? null };
        } else if (!draft.groups[event.chatId]) {
          draft.pendingGroups[event.chatId] = { title: event.title ?? null };
        }
      }
    });
  }

  private async sweepDeferred(jobId: string): Promise<boolean> {
    for (const entry of this.active.values()) {
      const job = entry.state.job(jobId);
      if (!job) continue;
      if (job.delivery === "done") return true;
      if (job.deadlineAt && Date.now() < job.deadlineAt) return false;
      return entry.bridge.resumeDeferred(jobId);
    }
    return true;
  }

  async onPermissionResolved(agentId: string, requestId: string): Promise<void> {
    for (const entry of this.active.values()) {
      await entry.bridge.onPermissionResolved(agentId, requestId).catch(() => {});
    }
  }

  async list(): Promise<{ channels: { channel: ChannelId; connections: ConnectionView[] }[] }> {
    const views: Partial<Record<ChannelId, ConnectionView[]>> = {};
    const agents = this.active.size ? await listUnarchivedAgents(await this.daemon()) : [];
    const agentIds = new Set(agents.map(agent => agent.id));
    for (const connection of this.registry.list()) {
      const entry = this.active.get(connection.id);
      const state = entry?.state ?? null;
      const jobs = state?.get().jobs ?? {};
      const conversations = Object.entries(state?.get().conversations ?? {})
        .filter(([, value]) => value.agentId !== null && agentIds.has(value.agentId))
        .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
        .slice(0, 50)
        .map(([key, value]) => ({
          key,
          title: value.title,
          agentId: value.agentId,
          workspaceId: value.workspaceId,
          current: false,
          active: Boolean(entry && value.agentId),
        }));
      const groups = Object.entries(state?.get().groups ?? {}).map(([id, value]) => ({ id, title: value.title }));
      const pendingGroups = Object.entries(state?.get().pendingGroups ?? {}).map(([id, value]) => ({
        id,
        title: value.title,
      }));
      const view: ConnectionView = {
        config: connection,
        running: Boolean(entry) && this.ready.has(connection.id),
        lastError: this.errors.get(connection.id) ?? null,
        ready: this.ready.has(connection.id),
        queued: Object.values(jobs).filter((job) => !job.delivery && !job.failure).length,
        ownerPaired: true,
        conversations,
        groups,
        pendingGroups,
      };
      (views[connection.channel] ??= []).push(view);
    }
    return {
      channels: CHANNEL_IDS.map((channel) => ({
        channel,
        connections: views[channel] ?? [],
      })),
    };
  }

  async choices(): Promise<{
    agents: { id: string; title: string }[];
    workspaces: { id: string; name: string }[];
    providers: {
      id: string;
      label: string;
      models: { id: string; label: string; modes: { id: string; label: string }[]; thinking: { id: string; label: string }[] }[];
    }[];
  }> {
    const api = await this.daemon();
    const [agentList, workspaceList, providerSnapshot] = await Promise.all([
      listUnarchivedAgents(api),
      api.workspaces.list().catch(() => null),
      api.providers.snapshot().catch(() => null),
    ]);
    const agentEntries = agentList;
    const workspaceEntries = workspaceList?.entries ?? [];
    const providerEntries = (providerSnapshot as { entries?: unknown[] } | null)?.entries ?? [];
    const mappedProviders = mapProviderChoices(providerEntries);
    return {
      agents: agentEntries.map(agent => ({ id: agent.id, title: agent.title ?? agent.id })),
      workspaces: workspaceEntries.map((entry) => {
        const workspace = entry as { id: string; name?: string | null };
        return { id: workspace.id, name: workspace.name ?? workspace.id };
      }),
      providers: mappedProviders,
    };
  }
}


