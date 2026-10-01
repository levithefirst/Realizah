import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedOutputTokens, outputBudget, outputTokensFor } from "../lib/task/outputBudget";
import { understandTask } from "../lib/task/understand";
import { expectedInputTokens, worstCaseCostUsd, worstCaseInputTokens } from "../lib/pricing";
import { DEFAULT_LIMITS } from "./fixtures";

const B = (task: string, useCase = "") => outputBudget(understandTask({ task, useCase }), DEFAULT_LIMITS);

test("ceilings follow the task, not the global 4096", () => {
  assert.equal(B("Write a cold email under 100 words.").tokens, 204);
  assert.equal(B("Write a 1,000-word article about remote work.").tokens, 1674); // 1,150 words x 1.4 + 64
  assert.equal(B("Write at least 300 words about tea.").tokens, 694); // 450 x 1.4 + 64
  assert.equal(B("Give me 5 taglines for a bakery, under 8 words each, as a numbered list").tokens, 140);
  assert.equal(B("Give me 5 taglines for a bakery as a numbered list").tokens, 364);
  assert.equal(B("Return JSON with fields name, email, company for: Ana from Acme").tokens, 320); // 128 + 4 x 48
  assert.equal(B("Summarize this paragraph: the sky is blue.").tokens, 400);
  assert.ok(B("Write a 1,000-word article about remote work.").tokens < DEFAULT_LIMITS.maxOutputTokens);
});

test("coding ceilings scale with the task and with requested tests", () => {
  const plain = B("Write a TypeScript function that reverses a string.", "coding").tokens;
  const withTests = B("Write a TypeScript function that reverses a string, with unit tests.", "coding").tokens;
  assert.ok(plain >= 600 && plain <= 2400);
  assert.ok(withTests > plain);
  const big = B("Refactor this module:\n```ts\n" + "const x = 1;\n".repeat(400) + "```", "coding").tokens;
  assert.ok(big > plain && big <= 3600);
});

test("the global ceiling is a hard cap", () => {
  const huge = outputBudget(understandTask({ task: "Write a 10,000-word report on solar power.", useCase: "" }), DEFAULT_LIMITS);
  assert.equal(huge.tokens, 4096);
  assert.match(huge.basis, /capped at the global 4096/);
});

test("reasoning headroom is bounded by the answer size and REASONING_HEADROOM_TOKENS", () => {
  assert.equal(outputTokensFor(true, 204, DEFAULT_LIMITS, null), 408);
  assert.equal(outputTokensFor(true, 1674, DEFAULT_LIMITS, null), 2698);
  assert.equal(outputTokensFor(true, 3500, DEFAULT_LIMITS, null), 4096);
  assert.equal(outputTokensFor(false, 1674, DEFAULT_LIMITS, 1000), 1000);
});

test("cost preflight: byte-level input bound and expected vs worst case", () => {
  assert.equal(worstCaseInputTokens("hello"), 5 + 16);
  assert.equal(worstCaseInputTokens("日本語"), 9 + 16); // 3 bytes per character
  assert.ok(worstCaseInputTokens("Write about tea.") >= expectedInputTokens("Write about tea."));
  const u = understandTask({ task: "Write a 1,000-word article about remote work.", useCase: "" });
  assert.ok(expectedOutputTokens(u, 1674) <= 1674);
  const p = { inputUsdPer1m: 0.4, outputUsdPer1m: 1.6 };
  assert.equal(worstCaseCostUsd(21, 1674, p), (21 * 0.4 + 1674 * 1.6) / 1e6);
});
