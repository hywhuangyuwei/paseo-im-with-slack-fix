import { z } from "zod";
import { atomicWrite, readJson, WriteChain } from "./files.ts";
import { connectionRoot } from "./paths.ts";
import { deliveryQueueKey } from "./model-command.ts";
import { join } from "node:path";

const seenCap = 1000;
const jobCap = 100;

const questionFieldSchema = z
  .object({
    header: z.string().max(200),
    text: z.string().max(4_000),
    options: z.array(z.string().max(500)).max(20).default([]),
  })
  .strict();

const questionSchema = z
  .object({
    requestId: z.string().min(1),
    fields: z.array(questionFieldSchema).max(10),
    messageId: z.string().max(256).nullable().default(null),
    notified: z.boolean().default(false),
    status: z.enum(["pending", "responding", "answered"]).default("pending"),
  })
  .strict();

export const jobSchema = z
  .object({
    messageId: z.string().min(1).max(256),
    conversationKey: z.string().min(1).max(400),
    chatId: z.string().min(1).max(256),
    threadId: z.string().max(256).nullable().default(null),
    senderId: z.string().min(1).max(256),
    text: z.string().max(20_000).nullable().default(null),
    routeKey: z.string().max(400).nullable().default(null),
    agentId: z.string().max(256).nullable().default(null),
    // Optional for old job literals/state files; resolved ID is durable across reloads.
    modelChange: z.object({
      modelId: z.string().min(1).max(512),
      applied: z.boolean(),
      notified: z.boolean(),
    }).strict().optional(),
    dispatch: z.enum(["sending", "sent"]).nullable().default(null),
    after: z
      .object({ epoch: z.string().max(128), seq: z.number().int() })
      .strict()
      .nullable()
      .default(null),
    answer: z.string().max(200_000).nullable().default(null),
    delivery: z.enum(["sending", "done", "uncertain"]).nullable().default(null),
    // Pi background notifications can start another turn after the original
    // reply. Only monitor work launched by this exact IM dispatch.
    followup: z.object({
      cursor: z.object({ epoch: z.string().max(128), seq: z.number().int() }).strict(),
      originSeen: z.boolean().default(false),
      pendingTasks: z.array(z.string().max(256)).max(100).default([]),
      waitingForReply: z.boolean().default(false),
      candidate: z.object({ id: z.string().max(256), text: z.string().max(200_000) }).strict().nullable().default(null),
      lastAnswer: z.string().max(200_000),
      sending: z.string().max(256).nullable().default(null),
      uncertain: z.boolean().default(false),
      expiresAt: z.number().int(),
    }).strict().nullable().default(null),
    progressMessageId: z.string().max(256).nullable().default(null),
    question: questionSchema.nullable().default(null),
    questionReply: z
      .object({
        sourceJobId: z.string().min(1).max(256),
        answers: z.record(z.string(), z.string().max(20_000)),
        followUpAfter: z
          .object({ epoch: z.string().max(128), seq: z.number().int() })
          .strict()
          .nullable()
          .default(null),
      })
      .strict()
      .nullable()
      .default(null),
    failure: z.string().max(2_000).nullable().default(null),
    deadlineAt: z.number().int().nullable().default(null),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })
  .strict();
export type Job = z.output<typeof jobSchema>;

const stateSchema = z
  .object({
    version: z.literal(1).default(1),
    cursors: z.record(z.string(), z.string().max(256)).default({}),
    seenMessageIds: z.array(z.string().max(256)).max(seenCap).default([]),
    conversations: z
      .record(
        z.string().max(400),
        z
          .object({
            title: z.string().max(200).nullable().default(null),
            agentId: z.string().max(256).nullable().default(null),
            workspaceId: z.string().max(256).nullable().default(null),
            updatedAt: z.number().int(),
          })
          .strict(),
      )
      .default({}),
    groups: z
      .record(
        z.string().max(256),
        z.object({ title: z.string().max(200).nullable().default(null) }).strict(),
      )
      .default({}),
    pendingGroups: z
      .record(
        z.string().max(256),
        z.object({ title: z.string().max(200).nullable().default(null) }).strict(),
      )
      .default({}),
    ownerPairing: z
      .object({
        hash: z.string().length(64),
        expiresAt: z.number().int(),
        ownerId: z.string().max(256).nullable().default(null),
        ownerChatId: z.string().max(256).nullable().default(null),
      })
      .strict()
      .nullable()
      .default(null),
    ownerId: z.string().max(256).nullable().default(null),
    ownerChatId: z.string().max(256).nullable().default(null),
    jobs: z.record(z.string().max(256), jobSchema).default({}),
  })
  .strict();

export type ConnectionState = z.output<typeof stateSchema>;

export function emptyState(): ConnectionState {
  return stateSchema.parse({});
}

/** Durable per-connection state: cursors, dedupe ring, conversations, group
 * admission, owner pairing, and the job table backing dispatch receipts. */
export class StateStore {
  private state: ConnectionState = emptyState();
  private readonly chain = new WriteChain();
  readonly path: string;

  constructor(connectionId: string, root: string = connectionRoot(connectionId)) {
    this.path = join(root, "state.json");
  }

  async load(): Promise<void> {
    this.state = (await readJson(this.path, stateSchema.parse)) ?? emptyState();
  }

  get(): ConnectionState {
    return this.state;
  }

  mutate(mutator: (state: ConnectionState) => void): Promise<void> {
    return this.chain.run(async () => {
      mutator(this.state);
      await atomicWrite(this.path, this.state);
    });
  }

  /** Write-chain quiescence: after this resolves no atomicWrite is in flight,
   * so tests and manager stop can delete/replace the state file safely. */
  drain(): Promise<void> {
    return this.chain.drain();
  }

  cursor(name: string): string | undefined {
    return this.state.cursors[name];
  }

  hasSeen(messageId: string): boolean {
    return this.state.seenMessageIds.includes(messageId);
  }

  markSeen(messageId: string): void {
    const seen = this.state.seenMessageIds.filter((id) => id !== messageId);
    seen.push(messageId);
    this.state.seenMessageIds = seen.slice(-seenCap);
  }

  job(id: string): Job | undefined {
    return this.state.jobs[id];
  }

  /** Frozen by a reload abort: delivered-never (dispatch null or "sending",
   * killed in the conversation/agent queue or before the sent mark) and
   * dispatched-never-answered (dispatch "sent"). Newest per delivery lane —
   * older model jobs are superseded by the conversation's later answer, but
   * read-only model queries cannot supersede unfinished model work. Jobs with
   * a pending question await user input, not delivery, and are excluded. */
  resumableJobs(): Job[] {
    const picked = new Map<string, Job>();
    for (const job of Object.values(this.state.jobs)) {
      if (job.delivery !== null || job.failure !== null || job.question !== null) continue;
      const key = deliveryQueueKey(job.conversationKey, job.text);
      const current = picked.get(key);
      // <= : same-millisecond ties break by insertion (arrival) order.
      if (!current || current.createdAt <= job.createdAt) picked.set(key, job);
    }
    return [...picked.values()];
  }

  ensureJob(id: string, seed: Pick<Job, "messageId" | "conversationKey" | "chatId" | "senderId" | "createdAt"> & Partial<Job>): Job {
    const existing = this.state.jobs[id];
    if (existing) return existing;
    const now = Date.now();
    const job = jobSchema.parse({
      ...seed,
      threadId: seed.threadId ?? null,
      createdAt: now,
      updatedAt: now,
    });
    this.state.jobs[id] = job;
    for (const [key, entry] of Object.entries(this.state.jobs)) {
      if (Object.keys(this.state.jobs).length <= jobCap) break;
      if (entry.delivery === "done" || entry.delivery === "uncertain") delete this.state.jobs[key];
    }
    return job;
  }

  updateJob(id: string, patch: Partial<Job>): Job | undefined {
    const job = this.state.jobs[id];
    if (!job) return undefined;
    const next = jobSchema.parse({ ...job, ...patch, updatedAt: Date.now() });
    this.state.jobs[id] = next;
    // 内存即时可见；落盘经写链异步串行（崩溃窗口为毫秒级）
    void this.chain.run(() => atomicWrite(this.path, this.state)).catch(() => {});
    return next;
  }

  dropJob(id: string): void {
    delete this.state.jobs[id];
  }
}

export { stateSchema };
