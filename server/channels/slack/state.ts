/** Persisted Slack adapter state: Socket Mode event ids (dedupe across
 * reconnects, at-least-once delivery) and the bot's own message timestamps. */
import { z } from "zod";
import { atomicWrite, readJson } from "../../files.ts";

export const SEEN_EVENT_CAP = 500;
export const OWN_MESSAGE_CAP = 200;
export const ACTIVE_THREAD_CAP = 500;

export interface SlackState {
  seenEventIds: string[];
  ownMessageTs: string[];
  activeThreads?: string[];
}

const stateSchema = z.looseObject({
  seenEventIds: z.array(z.string()).default([]),
  ownMessageTs: z.array(z.string()).default([]),
  activeThreads: z.array(z.string()).default([]),
});

function parseState(value: unknown): SlackState {
  const parsed = stateSchema.parse(value);
  return {
    seenEventIds: parsed.seenEventIds.slice(-SEEN_EVENT_CAP),
    ownMessageTs: parsed.ownMessageTs.slice(-OWN_MESSAGE_CAP),
    activeThreads: parsed.activeThreads.slice(-ACTIVE_THREAD_CAP),
  };
}

/** Missing or corrupted state resets to empty instead of blocking start. */
export async function loadSlackState(path: string): Promise<SlackState> {
  try {
    return (
      (await readJson(path, parseState)) ?? {
        seenEventIds: [],
        ownMessageTs: [],
        activeThreads: [],
      }
    );
  } catch {
    return { seenEventIds: [], ownMessageTs: [], activeThreads: [] };
  }
}

export async function saveSlackState(path: string, state: SlackState): Promise<void> {
  await atomicWrite(path, state);
}
