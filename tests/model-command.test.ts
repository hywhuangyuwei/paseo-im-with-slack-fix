import assert from "node:assert/strict";
import { test } from "node:test";
import { parseModelCommand, resolvePiModel } from "../server/model-command.ts";
import { mapProviderChoices } from "../server/choices.ts";

const providers = mapProviderChoices([
  { provider: "pi", models: [
    { id: "gateway/argon-v1", label: "Argon" },
    { id: "cloud/sol-alpha", label: "Sol A" },
    { id: "cloud/sol-b", label: "Sol B" },
    { id: "local/deepseek-v4.1", label: "DeepSeek 4.1 Local" },
    { id: "remote/deepseek-v4.1", label: "DeepSeek 4.1 Remote" },
  ] },
  { provider: "codex", models: [{ id: "other/argon", label: "Argon" }] },
]);

test("!m first-line parsing: body, no body, CRLF, whitespace, case", () => {
  assert.deepEqual(parseModelCommand("!m sol a\nMESSAGE\nmore"), { query: "sol a", body: "MESSAGE\nmore" });
  assert.deepEqual(parseModelCommand("  !M\targon  \r\n\r\nmessage\r\n"), { query: "argon", body: "message" });
  assert.deepEqual(parseModelCommand("!m argon"), { query: "argon", body: "" });
  assert.deepEqual(parseModelCommand("!m"), { query: "", body: "" });
  for (const text of [null, "hello\n!m argon", "```\n!m argon\n```", "!model argon", "!more", "!m/argon", ""]) {
    assert.equal(parseModelCommand(text), null);
  }
});

test("simple case-insensitive all-term substring matching on Pi ID and label", () => {
  assert.equal(resolvePiModel("ARGON", providers).id, "gateway/argon-v1");
  assert.equal(resolvePiModel("sol a", providers).id, "cloud/sol-alpha");
  assert.equal(resolvePiModel("4.1 local", providers).id, "local/deepseek-v4.1");
  assert.equal(resolvePiModel("local 4.1", providers).id, "local/deepseek-v4.1");
  assert.equal(resolvePiModel("pi/local/deepseek-v4.1", providers).id, "local/deepseek-v4.1");
});

test("exact ID wins over longer substring IDs; duplicate catalog IDs are collapsed", () => {
  const choices = mapProviderChoices([{ provider: "pi", models: [{ id: "x/sol" }, { id: "x/sol-a" }, { id: "x/sol" }] }]);
  assert.equal(resolvePiModel("x/sol", choices).id, "x/sol");
});

test("ambiguous/no match/empty/unavailable never select silently", () => {
  assert.throws(() => resolvePiModel("sol", providers), /匹配到 2 个.*模型未修改[\s\S]*sol-alpha[\s\S]*sol-b/);
  assert.throws(() => resolvePiModel("missing", providers), /没有找到匹配/);
  assert.throws(() => resolvePiModel("", providers), /用法/);
  assert.throws(() => resolvePiModel("argon", []), /没有可查询/);
  const many = mapProviderChoices([{ provider: "pi", models: Array.from({ length: 12 }, (_, i) => ({ id: `p/model-${i}` })) }]);
  assert.throws(() => resolvePiModel("model", many), /匹配到 12 个[\s\S]*仅列出前 10 个/);
});
