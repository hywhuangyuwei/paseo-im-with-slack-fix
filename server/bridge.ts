import type { PaseoApi } from "@getpaseo/client";
import { createHash } from "node:crypto";
import type { Connection } from "../shared/config.ts";
import { UserFacingError, userMessage } from "../shared/errors.ts";
import type { ImSettings } from "../shared/settings.ts";
import { conversationKey as keyOf, type NormalizedMessage } from "../shared/model.ts";
import {
  questionAnswers,
  questionText,
  refreshLinkedAgent,
  waitForAnswerTurn,
  waitForTask,
  type ParsedQuestion,
} from "./agents.ts";
import type { ChannelAdapter } from "./channels/types.ts";
import { AgentQueue } from "./queue.ts";
import { splitChunks } from "./format/chunks.ts";
import { isAuthorized, deniedHint } from "./policy.ts";
import { createProgressSink, type ProgressSink } from "./progress.ts";
import { Router } from "./routing.ts";
import type { Job, StateStore } from "./state-store.ts";
import { advanceFollowup } from "./followup.ts";

const maxInputChars = 12_000;
const progressIntervalMs = 4_000;
const timelineScanLimit = 200;

export interface BridgeDeps {
  connectionId: string;
  config: () => Connection;
  adapter: () => ChannelAdapter;
  state: StateStore;
  queue: AgentQueue;
  daemon: () => Promise<PaseoApi>;
  settings: () => Promise<ImSettings>;
  deferred: { track(jobId: string): void; resolve(jobId: string): void };
  followups?: { track(jobId: string): void };
  signal: AbortSignal;
  log: (level: "info" | "warn" | "error", message: string) => void;
}

export function messageIdentity(connectionId: string, messageId: string): string {
  const hex = createHash("sha256").update(`${connectionId}:${messageId}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export class Bridge {
  private readonly deps: BridgeDeps;
  private readonly router: Router;

  constructor(deps: BridgeDeps, router: Router) {
    this.deps = deps;
    this.router = router;
  }

  async handle(message: NormalizedMessage): Promise<void> {
    const { state, config: readConfig } = this.deps;
    if (state.hasSeen(message.messageId)) return;
    const config = readConfig();
    if (message.text && message.text.length > maxInputChars) {
      message = { ...message, text: `${message.text.slice(0, maxInputChars)}\n…（超长已截断）` };
    }

    const isAdmin =
      message.kind === "group" && config.policy.groupUsers === "admins"
        ? await this.deps.adapter().isAdmin?.(message.chatId, message.senderId) === true
        : false;
    if (!isAuthorized({ message, policy: config.policy, isAdmin })) {
      if (message.kind === "dm" && message.trigger.command) {
        await this.deps.adapter().sendText({ chatId: message.chatId, text: deniedHint(config.policy) }).catch(() => {});
      }
      return;
    }

    // A reply to a pending question form is control input, never a new task.
    if (message.replyTo?.id) {
      let matched = Object.values(state.get().jobs).find(
        (job) =>
          job.question !== null &&
          job.question.messageId === message.replyTo?.id &&
          job.question.status !== "answered",
      );
      if (!matched) {
        // sendText 无平台回执 id 的渠道（如 wecom-app）里 question.messageId
        // 为 null，回复卡片的引用 id 无法精确命中。兜底：仅当本连接恰有一个
        // 未答问题、且其会话与当前消息相同时按该问题处理；多于一个不猜，仍按
        // 新任务处理，避免吞掉无关消息。
        const pending = Object.values(state.get().jobs).filter(
          (job) => job.question !== null && job.question.status === "pending",
        );
        const inConversation = pending.filter((job) => job.conversationKey === keyOf(message));
        if (pending.length === 1 && inConversation.length === 1) matched = inConversation[0];
      }
      const source = matched;
      if (source && source.question && source.agentId) {
        const answers = questionAnswers(
          { requestId: source.question.requestId, fields: source.question.fields },
          message.text ?? "",
        );
        if (!answers) {
          await this.deps
            .adapter()
            .sendText({
              chatId: message.chatId,
              threadId: message.threadId,
              text: "回答格式无法解析：请回复选项序号或按提示逐行回答。",
            })
            .catch(() => {});
          return;
        }
        await state.mutate((draft) => {
          const replyJob = draft.jobs[message.messageId];
          if (!replyJob) {
            const now = Date.now();
            draft.jobs[message.messageId] = {
              messageId: message.messageId,
              conversationKey: keyOf(message),
              chatId: message.chatId,
              threadId: message.threadId ?? null,
              senderId: message.senderId,
              text: message.text ?? null,
              routeKey: null,
              agentId: source.agentId,
              dispatch: null,
              after: null,
              answer: null,
              delivery: null,
              followup: null,
              progressMessageId: null,
              question: null,
              questionReply: { sourceJobId: source.messageId, answers, followUpAfter: null },
              failure: null,
              deadlineAt: null,
              createdAt: now,
              updatedAt: now,
            };
          }
          draft.seenMessageIds = [...draft.seenMessageIds.slice(-999), message.messageId];
        });
        this.deps.queue.run(
          `conversation:${keyOf(message)}`,
          () => this.deliver(message.messageId),
          this.deps.signal,
        );
        return;
      }
    }

    await state.mutate((draft) => {
      const now = Date.now();
      draft.jobs[message.messageId] = {
        messageId: message.messageId,
        conversationKey: keyOf(message),
        chatId: message.chatId,
        threadId: message.threadId ?? null,
        senderId: message.senderId,
        text: message.text ?? null,
        routeKey: null,
        // agentId 不预填：统一由 prepare 解析并负责归档轮换
        agentId: null,
        dispatch: null,
        after: null,
        answer: null,
        delivery: null,
        followup: null,
        progressMessageId: null,
        question: null,
        questionReply: null,
        failure: null,
        deadlineAt: null,
        createdAt: now,
        updatedAt: now,
      };
      draft.seenMessageIds = [...draft.seenMessageIds.slice(-999), message.messageId];
      const conversation = draft.conversations[keyOf(message)];
      if (conversation) conversation.updatedAt = now;
    });
    this.deps.queue.run(
      `conversation:${keyOf(message)}`,
      () => this.deliver(message.messageId),
      this.deps.signal,
    );
  }

  private progress(job: Job): ProgressSink {
    return createProgressSink(this.deps.adapter(), job.chatId, job.threadId ?? undefined, this.deps.log);
  }

  private async refreshProgress(jobId: string, sink: ProgressSink, elapsed: number): Promise<void> {
    const mode = this.deps.adapter().capabilities.progress;
    if (mode === "none") return;
    if (mode === "typing") {
      await sink.refresh(elapsed);
      return;
    }
    const current = this.deps.state.job(jobId);
    if (!current || current.delivery === "done") return;
    const activity = await this.describeActivity(current).catch(() => undefined);
    await sink.refresh(elapsed, activity);
  }

  private async describeActivity(job: Job): Promise<string | undefined> {
    if (!job.agentId || !job.dispatch) return "正在准备会话…";
    if (job.dispatch === "sending" || !job.after) return "正在发送请求…";
    const api = await this.deps.daemon();
    const agent = api.agents.ref(job.agentId);
    const timeline = await agent.timeline.refetch({ direction: "tail", limit: 15 });
    if (timeline.epoch !== job.after.epoch) return "正在处理…";
    const entries = timeline.entries.filter((entry) => entry.seqEnd > job.after!.seq);
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const item = entries[i]?.item as { type?: string; name?: string; status?: string; text?: string } | undefined;
      if (!item || item.type === "user_message") continue;
      if (item.type === "compaction") return "正在整理上下文…";
      if (item.type === "tool_call") {
        const label = typeof item.name === "string" && item.name ? item.name : "工具";
        if (item.status === "running") return `正在执行 ${label}…`;
        return `已完成 ${label}，继续处理中…`;
      }
      if (item.type === "assistant_message" && typeof item.text === "string" && item.text.trim()) {
        return "正在生成回复…";
      }
      if (item.type === "reasoning") return "正在思考…";
      if (item.type === "todo") return "正在推进步骤…";
    }
    return "正在思考…";
  }

  private async answerWithTimeout(job: Job, sink: ProgressSink, budgetMs: number): Promise<string> {
    const timeout = Promise.withResolvers<never>();
    const timer = setTimeout(() => timeout.reject(new DeferredTimeoutError()), budgetMs);
    const wait = this.answer(job, sink);
    try {
      return await Promise.race([wait, timeout.promise]);
    } catch (error) {
      if (isDeferredTimeout(error)) {
        // The underlying wait keeps running; the deferred sweep picks up its result.
        void wait.catch(() => {});
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async deliver(jobId: string): Promise<void> {
    const { state, adapter: readAdapter } = this.deps;
    const job = state.job(jobId);
    if (!job || job.delivery === "done") return;
    const sink = this.progress(job);
    const timer = setInterval(() => {
      const elapsed = Math.max(1, Math.round((Date.now() - job.createdAt) / 1000));
      void this.refreshProgress(jobId, sink, elapsed).catch(() => {});
    }, progressIntervalMs);
    try {
      await sink.start();
      if (sink.messageId) {
        state.updateJob(jobId, { progressMessageId: sink.messageId });
      }
      const settings = await this.deps.settings();
      const budgetMs = Math.max(60_000, settings.deferTimeoutMinutes * 60_000);
      const answer = await this.answerWithTimeout(job, sink, budgetMs);
      clearInterval(timer);
      const firstChunks = splitChunks(answer, readAdapter().capabilities.maxChunkChars);
      const first = firstChunks[0] ?? answer;
      const replaced = await sink.finish(first).catch((error) => {
        this.deps.log("warn", `进度消息改写失败：${(error as Error).message}`);
        return null;
      });
      const rest = replaced ? firstChunks.slice(1) : firstChunks;
      for (const chunk of rest) {
        const sent = await readAdapter().sendText({
          chatId: job.chatId,
          threadId: job.threadId ?? undefined,
          text: chunk,
          replyToId: replaced ? undefined : job.messageId,
        });
        if (sent.messageId) readAdapter().rememberOwnMessage?.(sent.messageId);
      }
      await this.completeDelivery(jobId, answer);
      this.deps.deferred.resolve(jobId);
    } catch (error) {
      clearInterval(timer);
      if (this.deps.signal.aborted) return;
      await sink.abandon().catch(() => {});
      const raw = error instanceof Error ? (error.stack ?? error.message) : String(error);
      this.deps.log("error", `投递失败（${jobId}）：${raw}`);
      this.deps.log("error", `投递失败原因（${jobId}）：${userMessage(error)}`);
      if (error instanceof DeferredTimeoutError) {
        await state.mutate((draft) => {
          const entry = draft.jobs[jobId];
          if (entry) entry.deadlineAt = Date.now() + 60_000;
        });
        this.deps.deferred.track(jobId);
        await readAdapter()
          .sendText({
            chatId: job.chatId,
            threadId: job.threadId ?? undefined,
            text: "等待模型回复超时。任务仍在后台运行，完成后会把结果补发到这里。",
          })
          .catch(() => {});
        return;
      }
      const text = userMessage(error);
      state.updateJob(jobId, { failure: text });
      await readAdapter()
        .sendText({ chatId: job.chatId, threadId: job.threadId ?? undefined, text })
        .catch(() => {});
    } finally {
      clearInterval(timer);
    }
  }

  /** Marked on the job so the sweep can recover an answer after a timeout. */
  async resumeDeferred(jobId: string): Promise<boolean> {
    const { state, adapter: readAdapter } = this.deps;
    const job = state.job(jobId);
    if (!job || !job.agentId || job.delivery === "done") return true;
    const api = await this.deps.daemon();
    const agent = api.agents.ref(job.agentId);
    const result = await waitForTask(agent, this.deps.signal);
    if (result.status !== "idle" || !result.lastMessage?.trim()) return false;
    await this.deliverAnswer(job, result.lastMessage.trim());
    return true;
  }

  /** Reload recovery for abort-frozen jobs (conversation-queued, agent-queued,
   * or dispatched-never-answered): re-run the full deliver pipeline. The
   * findDispatch identity check makes agent dispatch idempotent, so a
   * "sending" job cannot double-send. Unstarted jobs (dispatch null) reset
   * their binding so prepare re-resolves the current routing — the agent
   * never received anything, and archive rotation is prepare's job anyway. */
  async rerunQueued(jobId: string): Promise<void> {
    const job = this.deps.state.job(jobId);
    if (!job || job.delivery === "done") return;
    if (job.dispatch === null && !job.questionReply && job.agentId !== null) {
      this.deps.state.updateJob(jobId, { agentId: null, routeKey: null });
    }
    await this.deps.queue.run(
      `conversation:${job.conversationKey}`,
      () => this.deliver(jobId),
      this.deps.signal,
    );
  }

  private async deliverAnswer(job: Job, answer: string): Promise<void> {
    const { state, adapter: readAdapter } = this.deps;
    const chunks = splitChunks(answer, readAdapter().capabilities.maxChunkChars);
    for (const chunk of chunks) {
      const sent = await readAdapter().sendText({
        chatId: job.chatId,
        threadId: job.threadId ?? undefined,
        text: chunk,
        replyToId: job.messageId,
      });
      if (sent.messageId) readAdapter().rememberOwnMessage?.(sent.messageId);
    }
    await this.completeDelivery(job.messageId, answer);
    this.deps.deferred.resolve(job.messageId);
  }

  /** Persist the first delivery and its timeline cursor together. The watcher
   * starts only for newly delivered IM jobs, never retroactively for old jobs. */
  private async completeDelivery(jobId: string, answer: string): Promise<void> {
    const { state, followups } = this.deps;
    await state.mutate((draft) => {
      const entry = draft.jobs[jobId];
      if (!entry) return;
      entry.answer = answer;
      entry.delivery = "done";
      if (followups && entry.after && entry.dispatch === "sent" && !entry.questionReply) {
        entry.followup = {
          cursor: { ...entry.after }, originSeen: false, pendingTasks: [],
          waitingForReply: false, candidate: null, lastAnswer: answer,
          sending: null, uncertain: false, expiresAt: Date.now() + 7 * 24 * 60 * 60_000,
        };
      }
      entry.updatedAt = Date.now();
    });
    if (state.job(jobId)?.followup) followups?.track(jobId);
  }

  /** Poll only an IM dispatch's own timeline. A matched Pi background-task
   * notification opens a follow-up; any later human input closes the watch.
   * Sends are serialized with new IM messages for the same conversation. */
  async resumeFollowup(jobId: string): Promise<boolean> {
    const job = this.deps.state.job(jobId);
    if (!job?.followup || !job.agentId || job.delivery !== "done") return true;
    // Do not queue behind a newer, possibly long-running IM request: a single
    // blocked watcher would otherwise hold up this connection's whole sweep.
    const jobs = Object.values(this.deps.state.get().jobs);
    const index = jobs.findIndex((entry) => entry.messageId === jobId);
    if (index < 0) return true;
    if (jobs.slice(index + 1).some((entry) => entry.conversationKey === job.conversationKey)) {
      await this.deps.state.mutate((draft) => { if (draft.jobs[jobId]) draft.jobs[jobId]!.followup = null; });
      return true;
    }
    return this.deps.queue.run(`conversation:${job.conversationKey}`, () => this.scanFollowup(jobId), this.deps.signal);
  }

  private async scanFollowup(jobId: string): Promise<boolean> {
    const { state, signal, log } = this.deps;
    const job = state.job(jobId);
    if (!job?.followup || !job.agentId) return true;
    const watch = structuredClone(job.followup);
    const close = async (reason: string): Promise<boolean> => {
      log("warn", `后台续跑跟踪结束（${jobId}）：${reason}`);
      await state.mutate((draft) => { if (draft.jobs[jobId]) draft.jobs[jobId]!.followup = null; });
      return true;
    };
    if (watch.uncertain) return true;
    if (watch.sending) {
      // No channel-wide idempotency key exists: after a crash mid-send we
      // cannot distinguish delivered from not delivered. Never blindly resend.
      await state.mutate((draft) => {
        const current = draft.jobs[jobId]?.followup;
        if (current) current.uncertain = true;
      });
      log("warn", `后台续跑投递状态不确定（${jobId}），请人工核对渠道消息。`);
      return true;
    }
    if (Date.now() > watch.expiresAt) return close("跟踪期限已到");
    const jobs = Object.values(state.get().jobs);
    const ownIndex = jobs.findIndex((entry) => entry.messageId === jobId);
    if (jobs.slice(ownIndex + 1).some((entry) => entry.conversationKey === job.conversationKey)) {
      return close("同一会话已有新消息");
    }
    const bound = state.get().conversations[job.conversationKey];
    if (!bound || bound.agentId !== job.agentId) return close("会话绑定已变化");
    const agent = (await this.deps.daemon()).agents.ref(job.agentId);
    const snapshot = await agent.refresh();
    if (!snapshot || snapshot.agent.archivedAt || snapshot.agent.status === "closed") return close("关联聊天不可用或已关闭");
    if (snapshot.agent.status !== "idle" || snapshot.agent.activeTurn) return false;

    // Use endCursor (not max seqEnd): projected tool calls may overlap other
    // entries, and jumping to max seqEnd skips those entries.
    let pages = 0;
    while (true) {
      signal.throwIfAborted();
      const previous = watch.cursor.seq;
      const page = await agent.timeline.refetch({ direction: "after", cursor: watch.cursor, limit: 200 });
      if (page.error) throw new Error(page.error);
      if (page.epoch !== watch.cursor.epoch || page.reset || page.staleCursor || page.gap) {
        return close("时间线已重置或出现缺口");
      }
      const entries = page.entries.filter((entry) => entry.seqStart > previous);
      if (advanceFollowup(watch, entries, messageIdentity(this.deps.connectionId, job.messageId)) === "superseded") {
        return close("时间线出现新的用户输入或无法关联的自动唤醒");
      }
      if (page.endCursor && page.endCursor.seq > previous) watch.cursor = page.endCursor;
      if (!page.hasNewer) break;
      if (watch.cursor.seq <= previous || ++pages >= 100) return close("时间线分页不完整");
    }
    if (!watch.originSeen) return close("找不到原 IM 消息，无法安全关联");
    // Refetch can race with a new turn. Never commit a partial running turn,
    // or send an old answer after another IM request entered this conversation.
    const tail = await agent.timeline.refetch({ direction: "after", cursor: watch.cursor, limit: 1 });
    if (tail.error) throw new Error(tail.error);
    if (tail.epoch !== watch.cursor.epoch || tail.reset || tail.staleCursor || tail.gap) {
      return close("时间线已重置或出现缺口");
    }
    if (tail.entries.some((entry) => entry.seqStart > watch.cursor.seq) || tail.hasNewer) return false;
    const latest = await agent.refresh();
    if (!latest || latest.agent.status !== "idle" || latest.agent.activeTurn) return false;
    const currentJobs = Object.values(state.get().jobs);
    const currentIndex = currentJobs.findIndex((entry) => entry.messageId === jobId);
    if (currentIndex < 0) return true;
    if (currentJobs.slice(currentIndex + 1).some((entry) => entry.conversationKey === job.conversationKey)) {
      return close("同一会话已有新消息");
    }
    if (watch.candidate?.text === watch.lastAnswer) {
      watch.candidate = null;
      watch.waitingForReply = false;
    }
    const candidate = watch.candidate;
    if (!candidate) {
      const finished = !watch.pendingTasks.length && !watch.waitingForReply;
      await state.mutate((draft) => {
        const current = draft.jobs[jobId];
        if (current) current.followup = finished ? null : watch;
      });
      return finished;
    }

    // Persist an in-flight marker *before* any external side effect. On a
    // crash or ambiguous transport error, prefer manual reconciliation to a
    // potentially duplicated multi-chunk message.
    watch.sending = candidate.id;
    await state.mutate((draft) => { if (draft.jobs[jobId]) draft.jobs[jobId]!.followup = watch; });
    try {
      for (const chunk of splitChunks(candidate.text, this.deps.adapter().capabilities.maxChunkChars)) {
        signal.throwIfAborted();
        const sent = await this.deps.adapter().sendText({
          chatId: job.chatId, threadId: job.threadId ?? undefined, text: chunk,
          replyToId: job.messageId,
        });
        if (sent.messageId) this.deps.adapter().rememberOwnMessage?.(sent.messageId);
      }
    } catch (error) {
      await state.mutate((draft) => {
        const current = draft.jobs[jobId]?.followup;
        if (current) current.uncertain = true;
      });
      log("error", `后台续跑投递状态不确定（${jobId}）：${(error as Error).message}`);
      return true;
    }
    watch.sending = null;
    watch.lastAnswer = candidate.text;
    watch.candidate = null;
    watch.waitingForReply = false;
    const finished = watch.pendingTasks.length === 0;
    await state.mutate((draft) => {
      const current = draft.jobs[jobId];
      if (current) current.followup = finished ? null : watch;
    });
    return finished;
  }

  private async answer(job: Job, sink: ProgressSink): Promise<string> {
    const api = await this.deps.daemon();
    if (!job.agentId) {
      const prepared = await this.router.prepare(
        this.deps.config(),
        this.deps.state,
        job.conversationKey,
        "",
      );
      job = this.deps.state.updateJob(job.messageId, { agentId: prepared.agentId, routeKey: job.conversationKey }) ?? job;
    }
    if (job.questionReply) {
      const receipt = await this.deps.queue.run(
        `question:${job.agentId}:${this.deps.state.job(job.questionReply.sourceJobId)?.question?.requestId ?? "unknown"}`,
        () => this.respondToQuestion(job, api, sink),
      );
      if (receipt) return receipt;
      const source = this.deps.state.job(job.questionReply.sourceJobId);
      if (source?.question?.status !== "answered") {
        throw new UserFacingError("回答未能确认送达，请在 Paseo 中检查该聊天。");
      }
      if (job.questionReply.followUpAfter) {
        await waitForAnswerTurn(api.agents.ref(job.agentId!), job.questionReply.followUpAfter, this.deps.signal);
      }
    }
    return this.deps.queue.run(`agent:${job.agentId}`, async () => {
      const agent = api.agents.ref(job.agentId!);
      if (!job.questionReply && job.dispatch !== "sent") {
        const snapshot = await refreshLinkedAgent(agent);
        if (!snapshot || snapshot.agent.archivedAt || snapshot.agent.status === "closed") {
          throw new UserFacingError("关联的 Paseo 聊天当前不可用。");
        }
        if (snapshot.agent.activeTurn) {
          await waitForTask(agent, this.deps.signal);
        }
        const after = await this.timelineAfter(agent);
        this.deps.state.updateJob(job.messageId, { dispatch: "sending", after });
        const identity = messageIdentity(this.deps.connectionId, job.messageId);
        const alreadySent = await this.findDispatch(agent, identity);
        if (!alreadySent) {
          const text = job.text ?? "";
          const prompt = text || "（此消息只包含附件）";
          await agent.send(prompt, { messageId: identity, activeTurnBehavior: "steer" });
        }
        this.deps.state.updateJob(job.messageId, { dispatch: "sent" });
      }
      const prior = new Set(this.pendingQuestionIds(job.agentId!));
      const result = await waitForTask(agent, this.deps.signal, async (question) => {
        prior.add(question.requestId);
        await this.notifyQuestion(job, api, question);
      }, prior);
      if (result.status === "idle") {
        const text = result.lastMessage?.trim();
        if (!text) throw new UserFacingError("任务已完成，但没有产生文本回复。");
        return text;
      }
      if (result.status === "permission") {
        throw new UserFacingError("任务正在等待权限确认，请在 Paseo 中处理。");
      }
      if (result.status === "error") {
        const detail = result.error?.trim() || result.lastMessage?.trim() || "";
        throw new UserFacingError(detail ? `任务执行失败：${detail.slice(0, 500)}` : "任务执行失败，请在 Paseo 中查看详情。");
      }
      throw new UserFacingError("任务未能完成，请在 Paseo 中查看详情。");
    });
  }

  private async timelineAfter(agent: ReturnType<PaseoApi["agents"]["ref"]>): Promise<{ epoch: string; seq: number }> {
    const timeline = await agent.timeline.refetch({ direction: "tail", limit: 1 });
    const seq = Math.max(0, ...timeline.entries.map((entry) => entry.seqEnd));
    return { epoch: timeline.epoch, seq };
  }

  private async findDispatch(agent: ReturnType<PaseoApi["agents"]["ref"]>, identity: string): Promise<boolean> {
    const timeline = await agent.timeline.refetch({ direction: "tail", limit: timelineScanLimit });
    for (const entry of timeline.entries) {
      const item = entry.item;
      if (item.type === "user_message" && "messageId" in item && item.messageId === identity) {
        return true;
      }
    }
    return false;
  }

  private pendingQuestionIds(agentId: string): string[] {
    // Questions observed before this dispatch must not be re-notified; the
    // bridge only knows its own job table, which is the persistence layer.
    const jobs = this.deps.state.get().jobs;
    return Object.values(jobs)
      .filter((entry) => entry.agentId === agentId && entry.question && entry.question.status !== "answered")
      .map((entry) => entry.question!.requestId);
  }

  private async notifyQuestion(job: Job, api: PaseoApi, question: ParsedQuestion): Promise<void> {
    const adapter = this.deps.adapter();
    const sent = await adapter
      .sendText({
        chatId: job.chatId,
        threadId: job.threadId ?? undefined,
        text: questionText(question),
        replyToId: job.progressMessageId ?? undefined,
      })
      .catch(() => null);
    this.deps.state.updateJob(job.messageId, {
      question: {
        requestId: question.requestId,
        fields: question.fields,
        messageId: sent?.messageId ?? null,
        notified: true,
        status: "pending",
      },
    });
  }

  private async respondToQuestion(job: Job, api: PaseoApi, sink: ProgressSink): Promise<string | undefined> {
    const reply = job.questionReply!;
    const state = this.deps.state;
    const source = state.job(reply.sourceJobId);
    if (!source?.question || source.question.status === "answered") {
      return "该问题已回答过；发送新消息即可继续。";
    }
    const agent = api.agents.ref(source.agentId ?? job.agentId!);
    const snapshot = await refreshLinkedAgent(agent);
    if (!snapshot || snapshot.agent.archivedAt || snapshot.agent.status === "closed") {
      throw new UserFacingError("关联的 Paseo 聊天当前不可用。");
    }
    const request = snapshot.agent.pendingPermissions?.find(
      (entry) => entry.id === source.question!.requestId && entry.kind === "question",
    );
    if (!request) {
      state.updateJob(source.messageId, {
        question: { ...source.question, status: "answered" },
      });
      return "该问题已在 Paseo 中处理。";
    }
    if (request.name === "request_user_input_async") {
      reply.followUpAfter = await this.timelineAfter(agent);
    }
    state.updateJob(source.messageId, {
      question: { ...source.question, status: "responding" },
    });
    await agent.respondToPermission({
      requestId: source.question!.requestId,
      response: { behavior: "allow", updatedInput: { answers: reply.answers } },
    });
    const continuesInPlace = Object.values(state.get().jobs).some(
      (other) =>
        other.messageId !== job.messageId &&
        other.agentId === job.agentId &&
        other.dispatch === "sent" &&
        !other.delivery &&
        !other.answer,
    );
    for (const other of Object.values(state.get().jobs)) {
      if (other.agentId === job.agentId && other.question?.requestId === source.question!.requestId) {
        state.updateJob(other.messageId, {
          question: other.question ? { ...other.question, status: "answered" } : null,
        });
      }
    }
    if (continuesInPlace) {
      return "已收到回答，任务正在继续。";
    }
    return undefined;
  }

  /** Called from the manager hook when a question is answered in Paseo. */
  async onPermissionResolved(agentId: string, requestId: string): Promise<void> {
    const { state } = this.deps;
    const jobs = Object.values(state.get().jobs).filter(
      (entry) => entry.agentId === agentId && entry.question?.requestId === requestId && entry.question.status !== "answered",
    );
    if (!jobs.length) return;
    await state.mutate((draft) => {
      for (const job of jobs) {
        const entry = draft.jobs[job.messageId];
        if (entry?.question) entry.question.status = "answered";
      }
    });
  }
}

export class DeferredTimeoutError extends Error {}

export function isDeferredTimeout(error: unknown): error is DeferredTimeoutError {
  return error instanceof DeferredTimeoutError;
}
