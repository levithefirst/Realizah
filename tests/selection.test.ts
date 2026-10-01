import { test } from "node:test";
import assert from "node:assert/strict";
import { familyKey, selectCandidates } from "../lib/selection/select";
import { understandTask } from "../lib/task/understand";
import { access, bigRegistry, DEFAULT_LIMITS, LIMITS, model } from "./fixtures";

const writing = understandTask({ task: "Write a 1,000-word article about remote work.", useCase: "long-form writing" });
const coding = understandTask({ task: "Write a Python function that parses ISO dates, with unit tests.", useCase: "coding" });
const OR = new Set(["openrouter"]);

test("queue: diverse core first, then expansion, all filtered before any call", () => {
  const r = selectCandidates({ registry: bigRegistry(), understanding: writing, providers: OR, limits: LIMITS });
  assert.equal(r.candidates.length, LIMITS.maxCandidates * 2); // room to skip and continue under the cap
  const core = r.candidates.filter((c) => c.role === "core");
  assert.equal(core.length, LIMITS.minCandidates);
  assert.equal(new Set(core.map((c) => c.model.creator)).size, core.length, "core uses distinct creators");
  assert.deepEqual(new Set(core.map((c) => c.priceTier)), new Set(["low", "mid", "high"]), "core spans every price tier");
  assert.ok(r.candidates.every((c) => c.model.outputModalities.join() === "text"));
  assert.equal(new Set(r.candidates.map((c) => familyKey(c.model.slug))).size, r.candidates.length, "no near-duplicates");
  assert.deepEqual(r.candidates.map((c) => c.rank), r.candidates.map((_, i) => i + 1));
  const first20Creators = new Set(r.candidates.slice(0, 20).map((c) => c.model.creator));
  assert.ok(first20Creators.size >= 8, `only ${first20Creators.size} creators`);
});

test("core is not biased toward cheap models: the high tier is always in it", () => {
  const r = selectCandidates({ registry: bigRegistry(), understanding: writing, providers: OR, limits: LIMITS });
  const core = r.candidates.filter((c) => c.role === "core");
  const maxWorst = Math.max(...r.candidates.map((c) => c.worstCaseCostUsd));
  const highCore = core.find((c) => c.priceTier === "high")!;
  assert.ok(highCore.worstCaseCostUsd > maxWorst * 0.5, "core includes a genuinely high-priced model");
  assert.equal(core[0].worstCaseCostUsd, Math.min(...core.map((c) => c.worstCaseCostUsd)), "cheapest core model runs first (paid screening)");
});

test("fewer relevant models than the limit: returns only those", () => {
  const reg = Array.from({ length: 7 }, (_, i) => model(`c${i}/m${i}`));
  reg.push(model("x/image", { outputModalities: ["image"] }));
  const r = selectCandidates({ registry: reg, understanding: writing, providers: OR, limits: LIMITS });
  assert.equal(r.candidates.length, 7);
  assert.equal(r.excluded.wrong_modality, 1);
});

test("capability filters: modality, context window, output capacity", () => {
  const reg = [
    model("a/ok"),
    model("b/image", { outputModalities: ["image"] }),
    model("c/tiny-context", { contextWindow: 1000 }),
    model("d/short-output", { maxOutputTokens: 256 }),
    model("e/ok2"),
  ];
  const r = selectCandidates({ registry: reg, understanding: writing, providers: OR, limits: LIMITS });
  assert.deepEqual(r.candidates.map((c) => c.model.slug).sort(), ["a/ok", "e/ok2"]);
  assert.equal(r.excluded.wrong_modality, 1);
  assert.equal(r.excluded.context_too_small, 1);
  assert.equal(r.excluded.output_limit_too_small, 1);
});

test("image tasks only consider models that output images", () => {
  const imageTask = understandTask({ task: "Design a logo for a bakery", useCase: "logos" });
  const reg = [model("a/text"), model("b/img", { outputModalities: ["image", "text"] }), model("c/img2", { outputModalities: ["image"] })];
  const r = selectCandidates({ registry: reg, understanding: imageTask, providers: OR, limits: LIMITS });
  assert.deepEqual(r.candidates.map((c) => c.model.slug).sort(), ["b/img", "c/img2"]);
});

test("provider selection: only configured providers, cheapest path, direct wins ties", () => {
  const both = model("openai/m", { access: [access("openrouter", "openai/m", 0.4, 1.6), access("openai", "m", 0.4, 1.6)] });
  const cheaperViaOR = model("openai/n", { access: [access("openrouter", "openai/n", 0.1, 0.4), access("openai", "n", 0.4, 1.6)] });
  const onlyOR = model("anthropic/x");
  const r1 = selectCandidates({ registry: [both, cheaperViaOR, onlyOR], understanding: writing, providers: new Set(["openrouter", "openai"]), limits: LIMITS });
  const via = Object.fromEntries(r1.candidates.map((c) => [c.model.slug, c.access.providerId]));
  assert.equal(via["openai/m"], "openai");
  assert.equal(via["openai/n"], "openrouter");
  const r2 = selectCandidates({ registry: [both, cheaperViaOR, onlyOR], understanding: writing, providers: new Set(["openai"]), limits: LIMITS });
  assert.deepEqual(r2.candidates.map((c) => c.access.providerId), ["openai", "openai"]);
  assert.equal(r2.excluded.no_configured_provider, 1);
});

test("registry-first exclusions: unknown prices, incompatible access, unconfigured, stale", () => {
  const reg = [
    model("a/priced"),
    model("b/unpriced", { access: [access("openrouter", "b/unpriced", null, null)] }),
    model("c/instruct", { access: [{ ...access("openrouter", "c/instruct", 0.1, 0.1), chatSupported: false }] }),
    model("d/stale", { status: "stale" }),
    model("e/elsewhere", { access: [access("together", "e", 0.1, 0.1)] }),
    model("f/priced"),
    model("g/audio", { outputModalities: ["text", "audio"] }),
  ];
  const r = selectCandidates({ registry: reg, understanding: writing, providers: OR, limits: LIMITS });
  assert.deepEqual(r.candidates.map((c) => c.model.slug).sort(), ["a/priced", "f/priced"]);
  assert.deepEqual(r.excluded, { price_unknown: 1, incompatible_access: 1, no_configured_provider: 1, wrong_modality: 1 });
  assert.equal(r.considered, 6); // stale models aren't considered at all
});

test("obviously excessive models are dropped before any call", () => {
  const reg = [model("a/cheap", { price: [0.1, 0.4] }), model("b/frontier", { price: [15, 75] }), model("c/cheap", { price: [0.2, 0.8] })];
  const r = selectCandidates({ registry: reg, understanding: writing, providers: OR, limits: DEFAULT_LIMITS, taskText: "Write a 1,000-word article about remote work." });
  assert.deepEqual(r.candidates.map((c) => c.model.slug).sort(), ["a/cheap", "c/cheap"]);
  assert.equal(r.excluded.excessive_cost, 1);
  assert.ok(r.candidates.every((c) => c.worstCaseCostUsd <= DEFAULT_LIMITS.maxCostPerCandidateUsd));
});

test("user budget filter lists models whose single task would exceed it", () => {
  const reg = [model("a/cheap", { price: [0.1, 0.4] }), model("b/pricey", { price: [5, 20] }), model("c/cheap", { price: [0.2, 0.8] })];
  const r = selectCandidates({ registry: reg, understanding: writing, providers: OR, limits: LIMITS, userBudgetUsd: 0.005 });
  assert.deepEqual(r.candidates.map((c) => c.model.slug).sort(), ["a/cheap", "c/cheap"]);
  assert.equal(r.overUserBudget[0].slug, "b/pricey");
  assert.ok(r.overUserBudget[0].worstCaseCostUsd > 0.005);
});

test("zero execution budget: no paid candidate survives preflight", () => {
  const r = selectCandidates({ registry: bigRegistry(), understanding: writing, providers: OR, limits: { ...DEFAULT_LIMITS, maxExecutionCostUsd: 0, maxCostPerCandidateUsd: 0 } });
  assert.equal(r.candidates.length, 0);
  assert.equal(r.screening.length, 0, "no screening without a paid comparison to inform");
  assert.ok((r.excluded.excessive_cost ?? 0) > 0);
});

test("free tiers become screening runs, never part of the paid queue", () => {
  const reg = [
    model("a/one", { access: [access("openrouter", "a/one", 0.1, 0.4), access("openrouter", "a/one:free", 0, 0)] }),
    model("b/two"),
    model("c/free-only", { access: [access("openrouter", "c/free-only:free", 0, 0)] }),
  ];
  const r = selectCandidates({ registry: reg, understanding: writing, providers: OR, limits: LIMITS });
  assert.ok(r.candidates.every((c) => !c.access.externalModelId.endsWith(":free")));
  assert.deepEqual(r.candidates.map((c) => c.model.slug).sort(), ["a/one", "b/two"]);
  assert.equal(r.excluded.free_tier_only, 1);
  assert.equal(r.screening.length, 2);
  assert.ok(r.screening.every((c) => c.role === "free_screening" && c.priceTier === "free" && c.worstCaseCostUsd === 0));
  const off = selectCandidates({ registry: reg, understanding: writing, providers: OR, limits: { ...LIMITS, freeScreeningModels: 0 } });
  assert.equal(off.screening.length, 0);
});

test("dynamic output ceiling and cost preflight feed every candidate", () => {
  const short = understandTask({ task: "Write a cold email under 100 words.", useCase: "email" });
  const r = selectCandidates({ registry: [model("a/x"), model("b/y", { capabilities: ["text_generation", "reasoning"] })], understanding: short, providers: OR, limits: DEFAULT_LIMITS, taskText: "Write a cold email under 100 words." });
  assert.equal(r.plannedOutputTokens, 204); // 100 x 1.4 + 64
  const plain = r.candidates.find((c) => c.model.slug === "a/x")!;
  const reasoning = r.candidates.find((c) => c.model.slug === "b/y")!;
  assert.equal(plain.maxOutputTokens, 204);
  assert.equal(reasoning.maxOutputTokens, 408); // + headroom, never more than the answer itself
  assert.ok(plain.expectedCostUsd < plain.worstCaseCostUsd);
  assert.ok(r.estimatedExecutionCostUsd <= r.worstCaseCoreUsd);
});

test("relevance uses the task's benchmark (a signal, not a winner)", () => {
  const reg = [
    model("a/low", { benchmarks: { coding_index: 10, intelligence_index: 60 } }),
    model("b/high", { benchmarks: { coding_index: 60, intelligence_index: 10 } }),
    model("c/mid", { benchmarks: { coding_index: 30, intelligence_index: 30 } }),
  ];
  const r = selectCandidates({ registry: reg, understanding: coding, providers: OR, limits: LIMITS });
  const rel = Object.fromEntries(r.candidates.map((c) => [c.model.slug, c.relevance]));
  assert.ok(rel["b/high"] > rel["c/mid"] && rel["c/mid"] > rel["a/low"]);
  assert.equal(r.candidates.length, 3, "low-benchmark models are still eligible");
});
