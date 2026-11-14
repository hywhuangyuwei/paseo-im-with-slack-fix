import type { PaseoAgent, PaseoApi } from "@getpaseo/client";

/** Read every page, including background agents, but never archived agents.
 * Do not turn a failed lookup into an unfiltered historical list. */
export async function listUnarchivedAgents(api: Pick<PaseoApi, "agents">): Promise<PaseoAgent[]> {
  const agents: PaseoAgent[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  do {
    const page = await api.agents.list({
      filter: { includeArchived: false, includeBackground: true },
      sort: [{ key: "created_at", direction: "desc" }],
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    agents.push(...page.entries.map(entry => entry.agent).filter(agent => !agent.archivedAt));
    cursor = page.pageInfo.nextCursor ?? undefined;
    if (cursor) {
      if (seenCursors.has(cursor)) throw new Error("Agent directory returned a repeated cursor");
      seenCursors.add(cursor);
    }
  } while (cursor);
  return agents;
}
