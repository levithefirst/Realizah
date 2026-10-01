import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMessages, executeCandidates } from "../lib/comparison/execute";
import { assignLabels } from "../lib/labels";
import { selectCandidates } from "../lib/selection/select";
import { understandTask } from "../lib/task/understand";
import type { ProviderAdapter, RunModelRequest, RunModelResult } from "../lib/providers/types";
import { bigRegistry, LIMITS } from "./fixtures";

const TASK = "  Write a 120-word product update for our customers.\nMention \"dark mode\" once. ✨ ";
const u = understandTask({ task: TASK, useCase: "writing" });
const words = (n: number) => Array.from({ length: n }, (_, i) => (i === 0 ? "dark mode" : "word")).join(" ");

function recordingAdapter(id: string, reply: (req: RunModelRequest) => Partial<RunModelResult> = () => ({})) {
  const calls: RunModelRequest[] = [];
  const adapter: ProviderAdapter = {
    id,
    isConfigured: () => true,
    async run(req) {
      calls.push(structuredClone(req));
      return {
        ok: true,
        text: words(120),
        inputTokens: 40,
        outputTokens: 180,
        totalTokens: 220,
        latencyMs: 10,
        finishReason: "stop",
        providerReportedCostUsd: 999, // must never be used as the estimate
        error: null,
        errorKind: null,
        ...reply(req),
      };
    },
  };
  return { adapter, calls };
}

function select(n = 20) {
  const sel = selectCandidates({ registry: bigRegistry(), understanding: u, providers: new Set(["openrouter"]), limits: { ...LIMITS, maxCandidates: n, minCandidates: Math.min(4, n) } });
  return { ...sel, candidates: sel.candidates.slice(0, n) };
}

test("20 candidates: every one receives the exact same user task, unchanged", async () => {
  const sel = select(20);
  assert.equal(sel.candidates.length, 20);
  const { adapter, calls } = recordingAdapter("openrouter");
  const outcomes = await executeCandidates({
    candidates: sel.candidates,
    messages: buildMessages(TASK),
    adapters: new Map([["openrouter", adapter]]),
    understanding: u,
    timeoutMs: 1000,
    maxConcurrent: 4,
  });
  assert.equal(calls.length, 20);
  assert.equal(outcomes.length, 20);
  for (const c of calls) assert.deepEqual(c.messages, [{ role: "user", content: TASK }]);
  assert.equal(new Set(calls.map((c) => JSON.stringify(c.messages))).size, 1);
  assert.deepEqual(calls.map((c) => c.externalModelId).sort(), sel.candidates.map((c) => c.access.externalModelId).sort());
});

test("cost comes from each candidate's price snapshot; passes get $/success", async () => {
  const sel = select(5);
  const { adapter } = recordingAdapter("openrouter");
  const outcomes = await executeCandidates({ candidates: sel.candidates, messages: buildMessages(TASK), adapters: new Map([["openrouter", adapter]]), understanding: u, timeoutMs: 1000, maxConcurrent: 2 });
  for (const o of outcomes) {
    const want = (40 * o.candidate.access.inputUsdPer1m! + 180 * o.candidate.access.outputUsdPer1m!) / 1e6;
    assert.ok(Math.abs(o.estimatedCostUsd! - want) < 1e-15);
    assert.equal(o.passed, true);
    assert.equal(o.costPerSuccessUsd, o.estimatedCostUsd);
  }
});

test("partial comparison: provider failure and timeout become error results with no cost", async () => {
  const sel = select(6);
  const failing = new Set([sel.candidates[1].access.externalModelId, sel.candidates[4].access.externalModelId]);
  const { adapter } = recordingAdapter("openrouter", (req) =>
    failing.has(req.externalModelId)
      ? req.externalModelId === sel.candidates[1].access.externalModelId
        ? { ok: false, text: "", inputTokens: null, outputTokens: null, totalTokens: null, error: "upstream 502", errorKind: "provider_error", finishReason: null }
        : { ok: false, text: "", inputTokens: null, outputTokens: null, totalTokens: null, error: "timed out", errorKind: "timeout", finishReason: null }
      : {}
  );
  const outcomes = await executeCandidates({ candidates: sel.candidates, messages: buildMessages(TASK), adapters: new Map([["openrouter", adapter]]), understanding: u, timeoutMs: 1000, maxConcurrent: 3 });
  const failed = outcomes.filter((o) => !o.run.ok);
  assert.equal(failed.length, 2);
  for (const o of failed) {
    assert.equal(o.estimatedCostUsd, null);
    assert.equal(o.costPerSuccessUsd, null);
    assert.equal(o.passed, false);
  }
  assert.equal(outcomes.filter((o) => o.passed).length, 4);
});

test("a failed result has no Better cost; zero successes means no Better cost at all", async () => {
  const sel = select(4);
  const { adapter } = recordingAdapter("openrouter", () => ({ text: words(20) })); // far under the 120-word target
  const outcomes = await executeCandidates({ candidates: sel.candidates, messages: buildMessages(TASK), adapters: new Map([["openrouter", adapter]]), understanding: u, timeoutMs: 1000, maxConcurrent: 2 });
  assert.ok(outcomes.every((o) => !o.passed && o.costPerSuccessUsd === null && o.estimatedCostUsd !== null));
  const labels = assignLabels(outcomes.map((o) => ({ key: o.candidate.model.slug, label: o.candidate.model.slug, passed: o.passed, estimatedCostUsd: o.estimatedCostUsd, costPerSuccessUsd: o.costPerSuccessUsd })));
  assert.equal(labels.better.length, 0);
  assert.equal(labels.cheaper.length >= 1, true); // Cheaper cost still exists among failed runs
});

test("an unconfigured provider yields an error result, not a silent substitute", async () => {
  const sel = select(2);
  const outcomes = await executeCandidates({ candidates: sel.candidates, messages: buildMessages(TASK), adapters: new Map(), understanding: u, timeoutMs: 1000, maxConcurrent: 2 });
  assert.ok(outcomes.every((o) => !o.run.ok && /not configured/.test(o.run.error!)));
});

test("concurrency is bounded", async () => {
  const sel = select(10);
  let inFlight = 0;
  let peak = 0;
  const adapter: ProviderAdapter = {
    id: "openrouter",
    isConfigured: () => true,
    async run() {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { ok: true, text: words(120), inputTokens: 1, outputTokens: 1, totalTokens: 2, latencyMs: 5, finishReason: "stop", providerReportedCostUsd: null, error: null, errorKind: null };
    },
  };
  await executeCandidates({ candidates: sel.candidates, messages: buildMessages(TASK), adapters: new Map([["openrouter", adapter]]), understanding: u, timeoutMs: 1000, maxConcurrent: 3 });
  assert.ok(peak <= 3, `peak ${peak}`);
});
