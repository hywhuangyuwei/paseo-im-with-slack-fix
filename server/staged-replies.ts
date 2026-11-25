export interface StageEntry {
  seqStart: number;
  seqEnd: number;
  turnId?: string;
  item: unknown;
}

export interface StagedReply {
  id: string;
  text: string;
}

/** Read a projected snapshot, NOT live text deltas. A later tool start or a
 * different assistant message seals the preceding text. The trailing message
 * stays with the normal final-answer path, even if it looks temporarily stable.
 * Re-read from the dispatch boundary: the trailing projected row is mutable. */
export function collectStagedReplies(entries: StageEntry[], identity: string): {
  stages: StagedReply[];
  last: StagedReply | null;
} | null {
  let originSeen = false;
  let turnId: string | undefined;
  let candidate: (StagedReply & { end: number }) | null = null;
  let last: StagedReply | null = null;
  const stages: StagedReply[] = [];
  const seal = () => {
    if (candidate?.text.trim()) stages.push({ id: candidate.id, text: candidate.text.trim() });
    candidate = null;
  };
  for (const entry of entries) {
    const item = entry.item as { type?: string; messageId?: string; clientMessageId?: string; text?: string; name?: string } | null;
    if (!item || typeof item !== "object") continue;
    if (item.type === "user_message") {
      if (originSeen || (item.messageId !== identity && item.clientMessageId !== identity)) return null;
      originSeen = true;
      turnId = entry.turnId;
      continue;
    }
    if (!originSeen) continue;
    // Background wakeups have their own ownership machinery in followup.ts.
    // Never forward their output as part of this still-active dispatch.
    if (item.type === "tool_call" && item.name === "background-task-notification") return null;
    if (turnId && entry.turnId && entry.turnId !== turnId) return null;
    if (item.type === "assistant_message" && typeof item.text === "string" && item.text.length) {
      const text = item.text.trim();
      // Pi tool-result images/extensions can also project assistant_message,
      // but have no model messageId. Do not promote those to model prose.
      const id = item.messageId;
      if (!id) continue;
      if (id.length > 256 || text.length > 200_000) return null;
      if (candidate && candidate.id !== id) seal();
      // Reasoning or an older tool update can separate projected fragments of
      // ONE model message. Rows are snapshot versions (deduped by seqStart by
      // the reader); distinct rows of the same id are additive, not replacements.
      candidate = { id, text: candidate ? candidate.text + item.text : item.text, end: entry.seqEnd };
      if (candidate.text.length > 200_000) return null;
      last = { id, text: candidate.text.trim() };
    } else if (item.type === "tool_call" && candidate && entry.seqStart > candidate.end) {
      // seqEnd of an older merged tool can span newer assistant rows. Only a
      // tool whose START is after this message proves a message boundary.
      seal();
    }
  }
  return originSeen ? { stages, last } : null;
}
