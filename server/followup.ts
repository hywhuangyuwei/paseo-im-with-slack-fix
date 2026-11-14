import type { Job } from "./state-store.ts";

type Watch = NonNullable<Job["followup"]>;
export type FollowupEntry = {
  seqStart: number;
  seqEnd: number;
  item: unknown;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Interpret only Paseo's Pi projection of a background launch/notification.
 * Never infer ownership from a message's text or the most recent agent output. */
export function advanceFollowup(watch: Watch, entries: FollowupEntry[], identity: string): "ok" | "superseded" {
  for (const entry of entries) {
    const item = record(entry.item);
    if (!item) continue;
    if (item.type === "user_message") {
      if (!watch.originSeen && (item.messageId === identity || item.clientMessageId === identity)) {
        watch.originSeen = true;
      } else {
        // A subsequent input may be from a different IM conversation or Paseo
        // client. Stop rather than forward any of its potentially private reply.
        return "superseded";
      }
      continue;
    }
    if (!watch.originSeen) continue;
    if (item.type === "tool_call") {
      const detail = record(item.detail);
      if (item.name === "bg_run" || item.name === "bg_delegate") {
        const output = record(detail?.output);
        const task = record(record(output?.details)?.task);
        if (item.status === "completed" && typeof task?.id === "string"
          && task.notifyOnCompletion === true && task.triggerOnCompletion === true
          && !watch.pendingTasks.includes(task.id)) {
          if (task.id.length > 256 || watch.pendingTasks.length >= 100) return "superseded";
          watch.pendingTasks.push(task.id);
        }
      } else if (item.name === "background-task-notification") {
        const metadata = record(item.metadata);
        const task = record(metadata?.details);
        if (metadata?.synthetic === true && metadata.customType === "background-task-notification"
          && task?.triggerOnCompletion === true) {
          // Another autonomous wakeup can produce its own answer without a
          // user_message. Do not mistake that answer for this job's result.
          if (typeof task.id !== "string" || !watch.pendingTasks.includes(task.id)) return "superseded";
          watch.pendingTasks = watch.pendingTasks.filter((id) => id !== task.id);
          watch.waitingForReply = true;
          watch.candidate = null;
        }
      }
      continue;
    }
    if (item.type === "assistant_message" && watch.waitingForReply
      && typeof item.messageId === "string" && typeof item.text === "string" && item.text.trim()) {
      const text = item.text.trim();
      if (item.messageId.length > 256 || text.length > 200_000) return "superseded";
      watch.candidate = { id: item.messageId, text };
    }
  }
  return "ok";
}
