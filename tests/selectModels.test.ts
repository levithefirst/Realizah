import { test } from "node:test";
import assert from "node:assert/strict";
import { selectModels, comparedAcross, DEFAULT_MAX_MODELS } from "../lib/selectModels";
import type { Tool } from "../lib/tools";

const tool = (slug: string, provider = "openai", enabled = true): Tool => ({
  slug,
  name: slug,
  provider,
  modelId: slug,
  pricingUrl: null,
  inputUsdPer1m: 0.1,
  outputUsdPer1m: 0.4,
  lastChecked: null,
  isUnknown: false,
  enabled,
});
const openai = new Set(["openai"]);

test("selects every enabled model the server holds a key for", () => {
  const pool = [tool("gpt-4o-mini"), tool("gpt-4.1-mini"), tool("gpt-4.1-nano")];
  assert.deepEqual(selectModels(pool, { providers: openai }).map((t) => t.slug), ["gpt-4.1-mini", "gpt-4.1-nano", "gpt-4o-mini"]);
});

test("not hard-coded to three: 5 and 10 models are all used", () => {
  for (const n of [5, 10]) {
    const pool = Array.from({ length: n }, (_, i) => tool(`m${i}`));
    assert.equal(selectModels(pool, { providers: openai }).length, n);
  }
});

test("disabled models and providers without a key are skipped", () => {
  const pool = [tool("a"), tool("b", "openai", false), tool("c", "anthropic"), tool("d")];
  assert.deepEqual(selectModels(pool, { providers: openai }).map((t) => t.slug), ["a", "d"]);
  assert.deepEqual(
    selectModels(pool, { providers: new Set(["openai", "anthropic"]) }).map((t) => t.slug),
    ["a", "c", "d"]
  );
});

test("a safety cap limits calls per run, and a verified model is always kept", () => {
  const pool = Array.from({ length: 15 }, (_, i) => tool(`m${String(i).padStart(2, "0")}`));
  assert.equal(selectModels(pool, { providers: openai }).length, DEFAULT_MAX_MODELS);
  assert.equal(selectModels(pool, { providers: openai, max: 4 }).length, 4);
  const withVerified = selectModels(pool, { providers: openai, max: 4, verifiedModelSlug: "m14" });
  assert.equal(withVerified.length, 4);
  assert.ok(withVerified.some((t) => t.slug === "m14"));
});

test("results heading uses the real count", () => {
  assert.equal(comparedAcross(3), "Compared across 3 models");
  assert.equal(comparedAcross(5), "Compared across 5 models");
  assert.equal(comparedAcross(10), "Compared across 10 models");
  assert.equal(comparedAcross(1), "Compared across 1 model");
});
