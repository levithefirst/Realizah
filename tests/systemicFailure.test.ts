// P2 regression: when every call failed with the same auth error, the
// progressive runner kept launching paid candidates up to the 10-model limit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMessages } from "../lib/comparison/execute";
import { isLabelEligible, runProgressive, systemicFailure } from "../lib/comparison/progressive";
import { selectCandidates } from "../lib/selection/select";
import { understandTask } from "../lib/task/understand";
import type { ProviderAdapter, RunModelRequest, RunModelResult } from "../lib/providers/types";
import { access, DEFAULT_LIMITS, model } from "./fixtures";

const TASK = "Write a product update for our customers. Keep it under 100 words.";
const u = understandTask({ task: TASK, useCase: "writing" });
const PASS = Array.from({ length: 80 }, () => "word").join(" ");
const AUTH: Partial<RunModelResult> = { ok: false, text: "", inputTokens: null, outputTokens: null, error: "Missing Authentication header", errorKind: "auth" };

function registry(providers: string[] = ["openrouter"]) {
  const creators = ["openai", "anthropic", "google", "deepseek", "qwen", "mistralai"];
  const reg = Array.from({ length: 14 }, (_, i) => {
    const price = [0.05, 0.1, 0.2, 0.4, 0.8, 1.2, 1.5, 2, 2.5, 3, 3.2, 3.5, 4, 5][i];
    const provider = providers[i % providers.length];
    return model(`${creators[i % 6]}/m${i}`, { access: [access(provider, provider === "openrouter" ? `${creators[i % 6]}/m${i}` : `m${i}`, price / 4, price)] });
  });
  reg.push(model("meta-llama/free-a", { access: [access("openrouter", "meta-llama/free-a:free", 0, 0)] }));
  reg.push(model("z-ai/free-b", { access: [access("openrouter", "z-ai/free-b:free", 0, 0)] }));
  return reg;
}

function adapter(id: string, behavior: (req: RunModelRequest) => Partial<RunModelResult>) {
  const calls: RunModelRequest[] = [];
  const a: ProviderAdapter = {
    id,
    isConfigured: () => true,
    async run(req) {
      calls.push(req);
      await new Promise((r) => setTimeout(r, 1 + Math.random() * 3));
      return { ok: true, text: PASS, inputTokens: 30, outputTokens: 110, totalTokens: 140, latencyMs: 2, finishReason: "stop", providerReportedCostUsd: null, error: null, errorKind: null, ...behavior(req) };
    },
  };
  return { a, calls };
}

async function run(providers: string[], adapters: ProviderAdapter[]) {
  const selection = selectCandidates({ registry: registry(providers), understanding: u, providers: new Set(providers), limits: DEFAULT_LIMITS, taskText: TASK });
  const res = await runProgressive({ selection, messages: buildMessages(TASK), adapters: new Map(adapters.map((a) => [a.id, a])), understanding: u, limits: DEFAULT_LIMITS });
  return { res, selection };
}

test("every call fails with the same auth error: stops after the first wave, not after 10 paid models", async () => {
  const or = adapter("openrouter", () => AUTH);
  const { res, selection } = await run(["openrouter"], [or.a]);
  assert.ok(selection.candidates.length >= 10);
  const paidCalls = or.calls.filter((c) => !c.externalModelId.endsWith(":free"));
  assert.equal(paidCalls.length, 1, "only the one paid call in wave 0");
  assert.equal(res.paidAttempted, 1);
  assert.match(res.stopReason, /Stopped early: every call to openrouter failed with the same auth error \(Missing Authentication header\)/);
  assert.ok(res.skipped.filter((s) => s.kind === "provider_failure").length >= selection.candidates.length - 1);
  assert.deepEqual(res.providerFailures.map((f) => [f.providerId, f.errorKind]), [["openrouter", "auth"]]);
  assert.match(systemicFailure(res)!, /every call to openrouter failed \(auth: Missing Authentication header\)/);
});

test("ordinary individual failures are not systemic: normal failover continues", async () => {
  // One model 401s (e.g. a gated model), one returns a 400; the rest work.
  const or = adapter("openrouter", (req) =>
    req.externalModelId === "openai/m0" ? AUTH : req.externalModelId === "google/m2" ? { ok: false, text: "", error: "bad request", errorKind: "provider_error" } : {}
  );
  const { res } = await run(["openrouter"], [or.a]);
  assert.equal(res.providerFailures.length, 0);
  assert.ok(!res.skipped.some((s) => s.kind === "provider_failure"));
  assert.ok(res.outcomes.filter(isLabelEligible).filter((o) => o.passed).length >= 2);
  assert.equal(systemicFailure(res), null);
});

test("different errors on every call are not the same systemic failure", async () => {
  let n = 0;
  const or = adapter("openrouter", () => ({ ...AUTH, error: `upstream ${n++} rejected` }));
  const { res } = await run(["openrouter"], [or.a]);
  assert.equal(res.providerFailures.length, 0, "no early abort without an identical signature");
  assert.ok(res.paidAttempted > 1);
  // Still nothing the user's task caused: the run doesn't use a free comparison.
  assert.ok(systemicFailure(res));
});

test("one provider down, another healthy: only the broken provider's queue is dropped", async () => {
  const or = adapter("openrouter", () => AUTH);
  const oa = adapter("openai", () => ({}));
  const { res } = await run(["openrouter", "openai"], [or.a, oa.a]);
  assert.deepEqual(res.providerFailures.map((f) => f.providerId), ["openrouter"]);
  assert.ok(res.skipped.filter((s) => s.kind === "provider_failure").every((s) => s.candidate.access.providerId === "openrouter"));
  assert.ok(oa.calls.length >= 2, "OpenAI-routed models still ran");
  assert.ok(res.outcomes.some((o) => o.run.ok));
  assert.equal(systemicFailure(res), null, "the user got a comparison");
});

test("systemicFailure: task-caused errors (provider_error) never count as systemic", () => {
  const o = (errorKind: RunModelResult["errorKind"], ok = false) => ({ run: { ok, errorKind, error: "x" } }) as any;
  assert.equal(systemicFailure({ outcomes: [o("provider_error"), o("auth")], providerFailures: [] }), null);
  assert.ok(systemicFailure({ outcomes: [o("timeout"), o("rate_limited"), o("network")], providerFailures: [] }));
  assert.equal(systemicFailure({ outcomes: [o(null, true), o("auth")], providerFailures: [] }), null);
  assert.equal(systemicFailure({ outcomes: [], providerFailures: [] }), "No model could be run.");
});

test("HTTP 401 rejects the credentials: one failed call is enough; a 403 on one model is not", async () => {
  // No free screening, so wave 0 holds a single paid call.
  const noFree = registry().filter((m) => !m.access.some((a) => a.externalModelId.endsWith(":free")));
  const go = async (status: number) => {
    const or = adapter("openrouter", () => ({ ...AUTH, httpStatus: status }));
    const selection = selectCandidates({ registry: noFree, understanding: u, providers: new Set(["openrouter"]), limits: DEFAULT_LIMITS, taskText: TASK });
    const res = await runProgressive({ selection, messages: buildMessages(TASK), adapters: new Map([["openrouter", or.a]]), understanding: u, limits: DEFAULT_LIMITS });
    return { res, paid: or.calls.length };
  };
  const unauthorized = await go(401);
  assert.equal(unauthorized.paid, 1, "nothing launched after the first 401");
  assert.equal(unauthorized.res.providerFailures[0].errorKind, "auth");
  const forbidden = await go(403);
  assert.ok(forbidden.paid > 1, "a single 403 could be one gated model; the core still runs");
  assert.ok(forbidden.paid < DEFAULT_LIMITS.maxCandidates, "identical 403s on every call still stop early");
});
