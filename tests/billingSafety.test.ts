// Regression: in production, OpenRouter's openai/gpt-6.1-sol-pro billed
// $0.008236 against a $0.002116 reservation (1,843 input tokens for an
// 11-word prompt; 455 output tokens against max_tokens 198). The runner then
// reported only "Meaningful comparison reached" in a similar run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMessages } from "../lib/comparison/execute";
import { isLabelEligible, runProgressive } from "../lib/comparison/progressive";
import { RESERVATION_MARGIN, reservationFactor, type RouteBillingHistory } from "../lib/comparison/billing";
import { selectCandidates } from "../lib/selection/select";
import { applyWordMaxOverride, understandTask } from "../lib/task/understand";
import type { ExecutionLimits } from "../lib/config";
import type { ProviderAdapter, RunModelRequest, RunModelResult } from "../lib/providers/types";
import { access, DEFAULT_LIMITS, model } from "./fixtures";

const TASK = "Explain the benefits of remote work for small teams.";
const u = applyWordMaxOverride(understandTask({ task: TASK, useCase: "writing" }), 25);
const OR = new Set(["openrouter"]);
const SOL = "openai/gpt-6.1-sol-pro";
const REPLY = Array.from({ length: 20 }, () => "word").join(" ");

// 12 ordinary routes over 6 creators, plus the overbilling route, made the
// most relevant high-tier model so it lands in the core as it did live.
function registry() {
  const creators = ["upstage", "perceptron", "unbiased", "anthropic", "cohere", "qwen"];
  const reg = Array.from({ length: 12 }, (_, i) => {
    const out = [0.2, 0.3, 0.5, 0.8, 1, 1.5, 2, 2.5, 3, 4, 5, 6][i];
    return model(`${creators[i % 6]}/m${i}`, { price: [out / 4, out] });
  });
  reg.push(model(SOL, { price: [2, 10], capabilities: ["reasoning", "text_generation"], releaseDate: "2026-09-30", benchmarks: { intelligence_index: 99 } }));
  return reg;
}
const solAccess = (reg = registry()) => reg.find((m) => m.slug === SOL)!.access[0];

function adapter(solBill: Partial<RunModelResult> = { inputTokens: 1843, outputTokens: 455, providerReportedCostUsd: 0.008236, finishReason: "length" }) {
  const calls: { model: string; at: number }[] = [];
  let t = 0;
  const a: ProviderAdapter = {
    id: "openrouter",
    isConfigured: () => true,
    async run(req: RunModelRequest) {
      calls.push({ model: req.externalModelId, at: t++ });
      await new Promise((r) => setTimeout(r, req.externalModelId === SOL ? 1 : 3));
      const base = { ok: true, text: REPLY, inputTokens: 25, outputTokens: 30, totalTokens: 55, latencyMs: 2, finishReason: "stop", providerReportedCostUsd: null, error: null, errorKind: null } as RunModelResult;
      return req.externalModelId === SOL ? { ...base, ...solBill } : base;
    },
  };
  return { a, calls };
}

async function run(limits: ExecutionLimits = DEFAULT_LIMITS, solBill?: Partial<RunModelResult>, history?: Map<string, RouteBillingHistory>) {
  const reg = registry();
  const selection = selectCandidates({ registry: reg, understanding: u, providers: OR, limits, taskText: TASK, billingHistory: history });
  const { a, calls } = adapter(solBill);
  const res = await runProgressive({ selection, messages: buildMessages(TASK, 25), adapters: new Map([["openrouter", a]]), understanding: u, limits, wordMaxOverride: 25 });
  return { res, selection, calls, reg };
}

test("reproduction: the sol-pro route reserves $0.002116 for this task, as in production", () => {
  const s = selectCandidates({ registry: registry(), understanding: u, providers: OR, limits: DEFAULT_LIMITS, taskText: TASK });
  const sol = s.candidates.find((c) => c.model.slug === SOL)!;
  assert.equal(sol.role, "core");
  assert.equal(sol.maxOutputTokens, 198);
  assert.ok(Math.abs(sol.worstCaseCostUsd - 0.002116) < 1e-6, String(sol.worstCaseCostUsd));
  assert.equal(sol.reservationFactor, 1);
});

test("an overbilling call is detected, recorded and its route marked unsafe; other routes keep running", async () => {
  const { res, selection } = await run();
  const sol = selection.candidates.find((c) => c.model.slug === SOL)!;
  assert.equal(res.ledger.overruns.length, 1);
  const o = res.ledger.overruns[0];
  assert.equal(o.externalModelId, SOL);
  assert.ok(Math.abs(o.reservedUsd - sol.worstCaseCostUsd) < 1e-12);
  assert.equal(o.billedUsd, 0.008236, "the provider's reported bill, not the token estimate alone");
  assert.ok(o.ratio > 3.8 && o.ratio < 4);
  assert.deepEqual([o.inputTokens, o.outputTokens, o.maxOutputTokens], [1843, 455, 198]);
  // Failover: the rest of the core and the comparison carried on.
  assert.ok(res.paidAttempted >= DEFAULT_LIMITS.minCandidates);
  assert.ok(res.outcomes.filter(isLabelEligible).filter((x) => x.passed).length >= 2);
  // The real bill is what the cap is held to.
  assert.ok(res.ledger.chargedUsd >= 0.008236);
  assert.ok(res.ledger.chargedUsd <= DEFAULT_LIMITS.maxExecutionCostUsd);
});

test("audit ordering: a cost violation in the core is named even when the comparison is otherwise meaningful", async () => {
  const { res } = await run();
  assert.equal(res.meaningful, true);
  assert.match(res.stopReason, /^Meaningful comparison reached/);
  assert.notEqual(res.stopReason.replace(/ Cost control:.*$/, ""), res.stopReason, "never just 'Meaningful comparison reached'");
  assert.match(res.stopReason, /Cost control: openai\/gpt-6\.1-sol-pro via openrouter billed \$0\.00824 against \$0\.00212 reserved \(3\.9x\); route marked unsafe/);
});

test("when the overrun leaves too little budget, cost control stops the run and says so", async () => {
  // Never "meaningful" (the others overrun the 25-word limit), one call at a
  // time, other calls cost nothing, and sol-pro's real bill leaves less than
  // the cheapest remaining reservation.
  const limits = { ...DEFAULT_LIMITS, maxCandidates: 20, maxConcurrent: 1 };
  const reg = registry();
  const selection = selectCandidates({ registry: reg, understanding: u, providers: OR, limits, taskText: TASK });
  const cheapestLeft = Math.min(...selection.candidates.filter((c) => c.role === "expansion").map((c) => c.worstCaseCostUsd));
  assert.ok(Number.isFinite(cheapestLeft));
  const bill = limits.maxExecutionCostUsd - cheapestLeft / 2;
  const calls: string[] = [];
  const a: ProviderAdapter = {
    id: "openrouter",
    isConfigured: () => true,
    async run(req) {
      calls.push(req.externalModelId);
      const sol = req.externalModelId === SOL;
      return { ok: true, text: `${REPLY} ${REPLY}`, inputTokens: sol ? 1843 : 0, outputTokens: sol ? 455 : 0, totalTokens: 0, latencyMs: 1, finishReason: "stop", providerReportedCostUsd: sol ? bill : null, error: null, errorKind: null };
    },
  };
  const res = await runProgressive({ selection, messages: buildMessages(TASK, 25), adapters: new Map([["openrouter", a]]), understanding: u, limits, wordMaxOverride: 25 });
  assert.equal(res.ledger.overruns.length, 1);
  assert.match(res.stopReason, /^Stopped by cost control: openai\/gpt-6\.1-sol-pro .* can't cover any remaining model's reservation\./);
  // Nothing launched after sol-pro: no remaining reservation fit what was left.
  assert.equal(calls.indexOf(SOL), calls.length - 1);
  assert.ok(res.ledger.chargedUsd <= limits.maxExecutionCostUsd);
  assert.ok(res.ledger.peakCommittedUsd <= limits.maxExecutionCostUsd + 1e-12);
  assert.ok(res.skipped.some((x) => x.kind === "budget" && /cost control/.test(x.reason)));
});

test("an overrun that breaks the cap itself stops everything at once, and the reason says so", async () => {
  const limits = { ...DEFAULT_LIMITS, maxConcurrent: 1 };
  const { res, calls } = await run(limits, { inputTokens: 10_000, outputTokens: 2_500, providerReportedCostUsd: 0.045 });
  assert.ok(res.ledger.chargedUsd > limits.maxExecutionCostUsd, "a first-time overrun can't be known before the call");
  assert.match(res.stopReason, /^Stopped by cost control: billing reached \$0\.04\d+, above the \$0\.03 cap, because openai\/gpt-6\.1-sol-pro/);
  const solAt = calls.find((c) => c.model === SOL)!.at;
  assert.equal(calls.filter((c) => c.at > solAt).length, 0, "nothing launched after the cap was broken");
});

test("an unsafe route is never launched again in the same comparison", async () => {
  // The same route queued twice (e.g. as two candidates) only runs once.
  const reg = registry();
  const selection = selectCandidates({ registry: reg, understanding: u, providers: OR, limits: DEFAULT_LIMITS, taskText: TASK });
  const sol = selection.candidates.find((c) => c.model.slug === SOL)!;
  selection.candidates.push({ ...sol, role: "expansion", rank: 99 });
  const { a, calls } = adapter();
  const limits = { ...DEFAULT_LIMITS, minCandidates: 30, maxCandidates: 30 }; // never "meaningful", so expansion runs
  const res = await runProgressive({ selection, messages: buildMessages(TASK, 25), adapters: new Map([["openrouter", a]]), understanding: u, limits, wordMaxOverride: 25 });
  assert.equal(calls.filter((c) => c.model === SOL).length, 1);
  assert.ok(res.skipped.some((s) => s.kind === "unsafe_route" && s.candidate.model.slug === SOL));
});

test("later plans: a route with a recent overrun reserves its observed ratio plus margin", () => {
  const reg = registry();
  const history = new Map([[solAccess(reg).accessId, { maxRatio: 3.89, events: 1, lastAt: "2026-10-02T08:07:07Z" }]]);
  assert.equal(reservationFactor(history.get(solAccess(reg).accessId)), 3.89 * RESERVATION_MARGIN);
  // At the default caps the raised reservation no longer fits: excluded, not launched.
  const tight = selectCandidates({ registry: reg, understanding: u, providers: OR, limits: DEFAULT_LIMITS, taskText: TASK, billingHistory: history });
  assert.ok(!tight.candidates.some((c) => c.model.slug === SOL));
  assert.ok((tight.excluded.excessive_cost ?? 0) >= 1);
  // With room to spare it still competes, reserving what it was seen to bill.
  const roomy = selectCandidates({ registry: reg, understanding: u, providers: OR, limits: { ...DEFAULT_LIMITS, maxCostPerCandidateUsd: 0.03 }, taskText: TASK, billingHistory: history });
  const sol = roomy.candidates.find((c) => c.model.slug === SOL)!;
  assert.ok(sol, "not blacklisted");
  assert.ok(Math.abs(sol.worstCaseCostUsd - 0.002116 * 3.89 * RESERVATION_MARGIN) < 1e-6);
  assert.ok(sol.worstCaseCostUsd > 0.008236, "covers the bill it was seen to run up");
  assert.match(sol.reason, /reserves 4\.9x its worst case after billing above it recently/);
  // No history (the window lapsed): back to the normal reservation.
  const fresh = selectCandidates({ registry: reg, understanding: u, providers: OR, limits: DEFAULT_LIMITS, taskText: TASK, billingHistory: new Map() });
  assert.equal(fresh.candidates.find((c) => c.model.slug === SOL)!.reservationFactor, 1);
});

test("later plans: a clean route of the same model is preferred over the one that overbilled", () => {
  const reg = registry().filter((m) => m.slug !== SOL);
  const dual = model(SOL, { access: [access("openrouter", SOL, 2, 10), access("openai", "gpt-6.1-sol-pro", 2, 10)] });
  reg.push(dual);
  const history = new Map([[dual.access[0].accessId, { maxRatio: 3.89, events: 1, lastAt: "2026-10-02T08:07:07Z" }]]);
  const s = selectCandidates({ registry: reg, understanding: u, providers: new Set(["openrouter", "openai"]), limits: DEFAULT_LIMITS, taskText: TASK, billingHistory: history });
  const sol = s.candidates.find((c) => c.model.slug === SOL)!;
  assert.equal(sol.access.providerId, "openai");
  assert.equal(sol.reservationFactor, 1);
});

test("a free route that billed is unsafe: it reserves $0, so it leaves screening", () => {
  const reg = registry();
  const free = model("z-ai/free-b", { access: [access("openrouter", "z-ai/free-b:free", 0, 0)] });
  reg.push(free);
  const clean = selectCandidates({ registry: reg, understanding: u, providers: OR, limits: DEFAULT_LIMITS, taskText: TASK });
  assert.ok(clean.screening.some((c) => c.model.slug === "z-ai/free-b"));
  const history = new Map([[free.access[0].accessId, { maxRatio: Infinity, events: 1, lastAt: "2026-10-02T08:07:07Z" }]]);
  const flagged = selectCandidates({ registry: reg, understanding: u, providers: OR, limits: DEFAULT_LIMITS, taskText: TASK, billingHistory: history });
  assert.ok(!flagged.screening.some((c) => c.model.slug === "z-ai/free-b"));
});

test("a free screening call that bills is recorded as an overrun and counted against the cap", async () => {
  const reg = registry();
  reg.push(model("z-ai/free-b", { access: [access("openrouter", "z-ai/free-b:free", 0, 0)] }));
  const selection = selectCandidates({ registry: reg, understanding: u, providers: OR, limits: DEFAULT_LIMITS, taskText: TASK });
  const { a } = adapter({});
  const billing: ProviderAdapter = { ...a, run: async (req) => ({ ...(await a.run(req)), ...(req.externalModelId.endsWith(":free") ? { providerReportedCostUsd: 0.0004 } : {}) }) };
  const res = await runProgressive({ selection, messages: buildMessages(TASK, 25), adapters: new Map([["openrouter", billing]]), understanding: u, limits: DEFAULT_LIMITS });
  const o = res.ledger.overruns.find((x) => x.externalModelId === "z-ai/free-b:free")!;
  assert.ok(o);
  assert.equal(o.reservedUsd, 0);
  assert.equal(o.ratio, Infinity);
  assert.ok(res.ledger.chargedUsd >= 0.0004);
  // Still never labeled.
  assert.ok(!res.outcomes.filter((x) => x.candidate.access.externalModelId === "z-ai/free-b:free").some(isLabelEligible));
});
