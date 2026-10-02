// P1 regression: wordMax only reached evaluation, so "wordMax=30" on a long
// essay still planned 700 output tokens. It now shapes the output budget,
// selection, max_tokens and evaluation alike.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMessages, runCandidate } from "../lib/comparison/execute";
import { parseComparisonInput } from "../lib/comparison/input";
import { selectCandidates } from "../lib/selection/select";
import { outputBudget } from "../lib/task/outputBudget";
import { applyWordMaxOverride, understandTask } from "../lib/task/understand";
import type { ProviderAdapter, RunModelRequest } from "../lib/providers/types";
import { DEFAULT_LIMITS, model } from "./fixtures";

const ESSAY = "Write a long essay on the history of the printing press and its effect on European society.";
const understand = (task: string, wordMax: number | null = null) => applyWordMaxOverride(understandTask({ task, useCase: "writing" }), wordMax);
const budget = (task: string, wordMax: number | null = null, limits = DEFAULT_LIMITS) => outputBudget(understand(task, wordMax), limits);

test("wordMax=30 sets the output budget (30 x 1.4 + 64 = 106), not the 700-token writing default", () => {
  assert.equal(budget(ESSAY).tokens, 700, "without an override: the category default");
  const b = budget(ESSAY, 30);
  assert.equal(b.tokens, 106);
  assert.match(b.basis, /30-word limit/);
});

test("long task + small wordMax: the override beats the task's own 1,000-word target", () => {
  const task = "Write a 1,000-word article explaining why small businesses should care about AI agents.";
  assert.equal(budget(task).tokens, 1674);
  const u = understand(task, 50);
  assert.deepEqual([u.constraints.wordCount!.max, u.constraints.wordCount!.target, u.constraints.wordCount!.min], [50, null, null]);
  assert.equal(outputBudget(u, DEFAULT_LIMITS).tokens, 134);
});

test("normal task without wordMax is unchanged", () => {
  const u = understand("Write a product update for our customers.");
  assert.equal(budget("Write a product update for our customers.").tokens, 700);
  assert.equal(applyWordMaxOverride(u, null), u, "no override: same object");
});

test("task with its own word limit: kept without wordMax, replaced with it", () => {
  const task = "Write a product update for our customers. Keep it under 100 words.";
  assert.equal(budget(task).tokens, 204);
  assert.equal(budget(task, 40).tokens, 120);
  assert.equal(budget(task, 300).tokens, 484, "a looser explicit limit is honoured too");
});

test("wordMax interacts with MAX_OUTPUT_TOKENS: still capped by the global ceiling", () => {
  const b = budget(ESSAY, 5000, { ...DEFAULT_LIMITS, maxOutputTokens: 4096 });
  assert.equal(b.tokens, 4096);
  assert.match(b.basis, /capped at the global 4096/);
});

test("wordMax flows through selection into each call's max_tokens and into evaluation", async () => {
  const u = understand(ESSAY, 30);
  const reg = [model("a/plain", { price: [0.1, 0.4] }), model("b/reasoner", { price: [0.2, 0.8], capabilities: ["reasoning", "text_generation"] })];
  const s = selectCandidates({ registry: reg, understanding: u, providers: new Set(["openrouter"]), limits: DEFAULT_LIMITS, taskText: ESSAY });
  assert.equal(s.plannedOutputTokens, 106);
  const plain = s.candidates.find((c) => c.model.slug === "a/plain")!;
  const reasoner = s.candidates.find((c) => c.model.slug === "b/reasoner")!;
  assert.equal(plain.maxOutputTokens, 106);
  assert.equal(reasoner.maxOutputTokens, 212, "reasoning headroom scales with the smaller budget");

  const sent: RunModelRequest[] = [];
  const adapter: ProviderAdapter = {
    id: "openrouter",
    isConfigured: () => true,
    run: async (req) => {
      sent.push(req);
      return { ok: true, text: Array.from({ length: 45 }, () => "word").join(" "), inputTokens: 20, outputTokens: 60, totalTokens: 80, latencyMs: 1, finishReason: "stop", providerReportedCostUsd: null, error: null, errorKind: null };
    },
  };
  const o = await runCandidate({ candidate: plain, messages: buildMessages(ESSAY), adapters: new Map([["openrouter", adapter]]), understanding: u, timeoutMs: 1000 });
  assert.equal(sent[0].maxTokens, 106);
  assert.equal(o.passed, false);
  assert.ok(o.evaluation!.checks.some((c) => c.status === "fail" && /over the 30-word limit/.test(c.detail)));
});

test("input parsing keeps wordMax for planning", () => {
  const r = parseComparisonInput({ tool: "ChatGPT", useCase: "writing", task: ESSAY, wordMax: "30" });
  assert.ok(r.ok && r.input.wordMaxOverride === 30);
});
