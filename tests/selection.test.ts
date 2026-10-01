import { test } from "node:test";
import assert from "node:assert/strict";
import { familyKey, selectCandidates } from "../lib/selection/select";
import { understandTask } from "../lib/task/understand";
import { access, bigRegistry, LIMITS, model } from "./fixtures";

const writing = understandTask({ task: "Write a 1,000-word article about remote work.", useCase: "long-form writing" });
const coding = understandTask({ task: "Write a Python function that parses ISO dates, with unit tests.", useCase: "coding" });
const OR = new Set(["openrouter"]);

test("selects 20 relevant, diverse candidates from a 300-model registry", () => {
  const r = selectCandidates({ registry: bigRegistry(), understanding: writing, providers: OR, limits: LIMITS });
  assert.equal(r.candidates.length, 20);
  const creators = new Set(r.candidates.map((c) => c.model.creator));
  assert.ok(creators.size >= 8, `only ${creators.size} creators`);
  const perCreator = Math.max(...[...creators].map((c) => r.candidates.filter((x) => x.model.creator === c).length));
  assert.ok(perCreator <= 3, `one creator has ${perCreator}`);
  assert.ok(r.candidates.every((c) => c.model.outputModalities.includes("text")));
  assert.equal(new Set(r.candidates.map((c) => familyKey(c.model.slug))).size, 20, "no near-duplicates");
  assert.ok(r.estimatedExecutionCostUsd <= LIMITS.maxExecutionCostUsd);
  assert.deepEqual(r.candidates.map((c) => c.rank), Array.from({ length: 20 }, (_, i) => i + 1));
});

test("not the 20 highest benchmarks: cheap models keep a share of the slots", () => {
  const r = selectCandidates({ registry: bigRegistry(), understanding: writing, providers: OR, limits: LIMITS });
  const prices = r.candidates.map((c) => c.access.inputUsdPer1m!);
  assert.ok(Math.min(...prices) <= 0.06, "cheapest tier represented");
  assert.ok(Math.max(...prices) > 2, "pricier tier represented");
});

test("fewer than 20 relevant models: returns only those", () => {
  const reg = Array.from({ length: 7 }, (_, i) => model(`c${i}/m${i}`));
  reg.push(model("x/image", { outputModalities: ["image"] }));
  const r = selectCandidates({ registry: reg, understanding: writing, providers: OR, limits: LIMITS });
  assert.equal(r.candidates.length, 7);
  assert.equal(r.excluded.wrong_modality, 1);
});

test("capability filters: modality, context window, output limit", () => {
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
  const reg = [model("a/text"), model("b/img", { outputModalities: ["image", "text"] })];
  const r = selectCandidates({ registry: reg, understanding: imageTask, providers: OR, limits: LIMITS });
  assert.deepEqual(r.candidates.map((c) => c.model.slug), ["b/img"]);
});

test("provider selection: only configured providers, cheapest path, direct wins ties", () => {
  const both = model("openai/m", {
    access: [access("openrouter", "openai/m", 0.4, 1.6), access("openai", "m", 0.4, 1.6)],
  });
  const cheaperViaOR = model("openai/n", {
    access: [access("openrouter", "openai/n", 0.1, 0.4), access("openai", "n", 0.4, 1.6)],
  });
  const onlyOR = model("anthropic/x");
  const r1 = selectCandidates({ registry: [both, cheaperViaOR, onlyOR], understanding: writing, providers: new Set(["openrouter", "openai"]), limits: LIMITS });
  const via = Object.fromEntries(r1.candidates.map((c) => [c.model.slug, c.access.providerId]));
  assert.equal(via["openai/m"], "openai");
  assert.equal(via["openai/n"], "openrouter");
  const r2 = selectCandidates({ registry: [both, cheaperViaOR, onlyOR], understanding: writing, providers: new Set(["openai"]), limits: LIMITS });
  assert.deepEqual(r2.candidates.map((c) => c.access.providerId), ["openai", "openai"]);
  assert.equal(r2.excluded.no_configured_provider, 1);
});

test("unknown prices, free variants, stale models and unconfigured providers are excluded", () => {
  const reg = [
    model("a/priced"),
    model("b/unpriced", { access: [access("openrouter", "b/unpriced", null, null)] }),
    model("c/free", { access: [access("openrouter", "c/free:free", 0, 0)] }),
    model("d/stale", { status: "stale" }),
    model("e/elsewhere", { access: [access("together", "e", 0.1, 0.1)] }),
    model("f/priced"),
  ];
  const r = selectCandidates({ registry: reg, understanding: writing, providers: OR, limits: LIMITS });
  assert.deepEqual(r.candidates.map((c) => c.model.slug).sort(), ["a/priced", "f/priced"]);
  assert.equal(r.excluded.price_unknown, 1);
  assert.equal(r.excluded.no_configured_provider, 2); // free-only and unconfigured provider
});

test("user budget filter lists models whose single task would exceed it", () => {
  const reg = [model("a/cheap", { price: [0.1, 0.4] }), model("b/pricey", { price: [150, 600] }), model("c/cheap", { price: [0.2, 0.8] })];
  const r = selectCandidates({ registry: reg, understanding: writing, providers: OR, limits: LIMITS, userBudgetUsd: 0.05 });
  assert.deepEqual(r.candidates.map((c) => c.model.slug).sort(), ["a/cheap", "c/cheap"]);
  assert.equal(r.overUserBudget[0].slug, "b/pricey");
  assert.ok(r.overUserBudget[0].worstCaseCostUsd > 0.05);
});

test("Realizah's execution budget caps total worst-case spend", () => {
  const tight = { ...LIMITS, maxExecutionCostUsd: 0.01 };
  const r = selectCandidates({ registry: bigRegistry(), understanding: writing, providers: OR, limits: tight });
  assert.ok(r.candidates.length > 0 && r.candidates.length < 20);
  assert.ok(r.estimatedExecutionCostUsd <= 0.01 + 1e-12);
  assert.ok((r.excluded.exceeds_execution_budget ?? 0) > 0);
});

test("MAX_CANDIDATES_PER_RUN bounds the number of calls", () => {
  const r = selectCandidates({ registry: bigRegistry(), understanding: writing, providers: OR, limits: { ...LIMITS, maxCandidates: 5 } });
  assert.equal(r.candidates.length, 5);
});

test("coding tasks rank by the coding benchmark within each creator", () => {
  const reg = [
    model("a/low", { benchmarks: { coding_index: 10, intelligence_index: 60 } }),
    model("a/high", { benchmarks: { coding_index: 60, intelligence_index: 10 } }),
    model("a/mid", { benchmarks: { coding_index: 30, intelligence_index: 30 } }),
  ];
  const r = selectCandidates({ registry: reg, understanding: coding, providers: OR, limits: { ...LIMITS, maxCandidates: 1 } });
  assert.equal(r.candidates[0].model.slug, "a/high");
});

test("benchmarks are signals only: a model without benchmarks is still eligible", () => {
  const reg = [model("a/bench", { benchmarks: { intelligence_index: 50 } }), model("b/nobench")];
  const r = selectCandidates({ registry: reg, understanding: writing, providers: OR, limits: LIMITS });
  assert.equal(r.candidates.length, 2);
});
