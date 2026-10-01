import { test } from "node:test";
import assert from "node:assert/strict";
import { formatUsd, taskCostUsd, worstCaseCostUsd } from "../lib/pricing";
import { perTokenToPer1m } from "../lib/registry/sources/openrouter";

test("per-1M prices are per token, not per request", () => {
  // $0.15 / 1M input, $0.60 / 1M output; 1,200 in + 800 out.
  const cost = taskCostUsd(1200, 800, { inputUsdPer1m: 0.15, outputUsdPer1m: 0.6 })!;
  assert.ok(Math.abs(cost - (1200 * 0.15 + 800 * 0.6) / 1e6) < 1e-15);
  assert.ok(cost < 0.001, "a short task costs fractions of a cent, not $0.15");
});

test("unknown price or tokens give unknown cost, never zero", () => {
  assert.equal(taskCostUsd(100, 100, { inputUsdPer1m: null, outputUsdPer1m: 1 }), null);
  assert.equal(taskCostUsd(null, 100, { inputUsdPer1m: 1, outputUsdPer1m: 1 }), null);
  assert.equal(formatUsd(null), "UNKNOWN");
});

test("per-request fees are added; worst case spends every output token", () => {
  assert.equal(taskCostUsd(0, 0, { inputUsdPer1m: 1, outputUsdPer1m: 1, requestUsd: 0.002 }), 0.002);
  assert.equal(worstCaseCostUsd(100, 1000, { inputUsdPer1m: 1, outputUsdPer1m: 2 }), (100 + 2000) / 1e6);
});

test("OpenRouter per-token strings convert to per-1M", () => {
  assert.equal(perTokenToPer1m("0.00000015"), 0.15);
  assert.equal(perTokenToPer1m("0.0000006"), 0.6);
  assert.equal(perTokenToPer1m("0"), 0);
  assert.equal(perTokenToPer1m("-1"), null); // variable pricing is unknown, not free
  assert.equal(perTokenToPer1m(undefined), null);
});
