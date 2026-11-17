import { UserFacingError } from "../shared/errors.ts";
import type { ProviderChoice } from "./choices.ts";

export interface ModelCommand {
  query: string;
  body: string;
}

/** Only a first-line !m is control input; prose and fenced examples stay intact. */
export function parseModelCommand(text: string | null | undefined): ModelCommand | null {
  if (!text) return null;
  const [first = "", ...rest] = text.replace(/\r\n/g, "\n").split("\n");
  const match = /^!m(?:[\t ]+(.*))?[\t ]*$/i.exec(first.trim());
  return match ? { query: (match[1] ?? "").trim(), body: rest.join("\n").trim() } : null;
}

/** Only a bare read-only query may bypass model work; switches stay ordered.
 * Recovery uses the same lane so a query cannot supersede an unfinished turn. */
export function deliveryQueueKey(conversationKey: string, text: string | null | undefined): string {
  const command = parseModelCommand(text);
  const lane = command && !command.query && !command.body ? "model-query" : "conversation";
  return `${lane}:${conversationKey}`;
}

/** Exact ID first; otherwise every whitespace-separated term must be a substring. */
export function resolvePiModel(query: string, providers: ProviderChoice[]): { id: string; label: string } {
  if (!query) throw new UserFacingError("用法：!m 模型关键词（例如 !m argon、!m sol a、!m 4.1 local）；正文可从下一行开始。模型未修改。");
  const models = [...new Map((providers.find((entry) => entry.id === "pi")?.models ?? [])
    .map((model) => [model.id, model])).values()];
  if (!models.length) throw new UserFacingError("当前没有可查询的 Pi 模型，模型未修改，正文未发送。");
  const lower = query.toLowerCase();
  const exact = models.filter((model) => model.id.toLowerCase() === lower || `pi/${model.id}`.toLowerCase() === lower);
  const terms = lower.split(/\s+/);
  const matches = exact.length ? exact : models.filter((model) => {
    const haystack = `${model.id} ${model.label}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  if (matches.length === 1) return matches[0]!;
  if (!matches.length) throw new UserFacingError(`没有找到匹配「${query}」的 Pi 模型。模型未修改，正文未发送；请换关键词或使用完整模型 ID。`);
  const candidates = matches.slice(0, 10).map((model) => `• ${model.id}（${model.label}）`).join("\n");
  throw new UserFacingError(`「${query}」匹配到 ${matches.length} 个 Pi 模型，模型未修改，正文未发送。请增加关键词或使用完整模型 ID：\n${candidates}${matches.length > 10 ? "\n…仅列出前 10 个" : ""}`);
}
