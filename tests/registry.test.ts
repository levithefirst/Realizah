import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOpenRouterCatalog } from "../lib/registry/sources/openrouter";
import { linkOpenAIDirect } from "../lib/registry/sources/openaiDirect";
import { normalizeArtificialAnalysis } from "../lib/registry/sources/artificialAnalysis";
import { deriveCapabilities } from "../lib/registry/capabilities";

const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  created: 1721260800,
  context_length: 128000,
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  pricing: { prompt: "0.00000015", completion: "0.0000006" },
  top_provider: { context_length: 128000, max_completion_tokens: 16384 },
  supported_parameters: ["max_tokens", "temperature"],
  ...extra,
});

test("catalog normalization: identity, access path, versionable price", () => {
  const n = normalizeOpenRouterCatalog([row("openai/gpt-4o-mini")]);
  assert.equal(n.models[0].slug, "openai/gpt-4o-mini");
  assert.equal(n.models[0].creator, "openai");
  assert.equal(n.models[0].releaseDate, "2024-07-18");
  assert.deepEqual(n.access[0], { modelSlug: "openai/gpt-4o-mini", providerId: "openrouter", externalModelId: "openai/gpt-4o-mini", source: "openrouter_catalog" });
  assert.deepEqual([n.prices[0].inputUsdPer1m, n.prices[0].outputUsdPer1m, n.prices[0].status], [0.15, 0.6, "verified"]);
});

test("free variants are an access path of the same model; routers are not models", () => {
  const n = normalizeOpenRouterCatalog([
    row("meta-llama/llama-x"),
    row("meta-llama/llama-x:free", { pricing: { prompt: "0", completion: "0" } }),
    row("openrouter/auto", { pricing: { prompt: "-1", completion: "-1" } }),
  ]);
  assert.deepEqual(n.models.map((m) => m.slug), ["meta-llama/llama-x"]);
  assert.deepEqual(n.access.map((a) => a.externalModelId), ["meta-llama/llama-x", "meta-llama/llama-x:free"]);
  assert.equal(n.skipped[0].id, "openrouter/auto");
});

test("variable or missing prices are unknown, never invented", () => {
  const n = normalizeOpenRouterCatalog([row("x/var", { pricing: { prompt: "-1", completion: "-1" } }), row("x/none", { pricing: {} })]);
  assert.deepEqual(n.prices.map((p) => p.status), ["unknown", "unknown"]);
  assert.deepEqual(n.prices.map((p) => p.inputUsdPer1m), [null, null]);
});

test("capabilities come from metadata, never from the model's name", () => {
  assert.deepEqual(deriveCapabilities({ inputModalities: ["text"], outputModalities: ["text"], supportedParameters: ["max_tokens"] }), ["text_generation"]);
  const rich = deriveCapabilities({ inputModalities: ["text", "image"], outputModalities: ["text"], supportedParameters: ["tools", "structured_outputs", "reasoning"] });
  assert.deepEqual(rich, ["image_input", "reasoning", "structured_output", "text_generation", "tool_use"]);
  const n = normalizeOpenRouterCatalog([row("acme/super-coder-reasoning-vision")]);
  assert.deepEqual(deriveCapabilities(n.models[0]), ["text_generation"]);
});

test("direct OpenAI access links by exact catalog id only, with honest price status", () => {
  const linked = linkOpenAIDirect({
    directIds: ["gpt-4o-mini", "gpt-4.1-nano", "whisper-1", "gpt-made-up"],
    registrySlugs: new Set(["openai/gpt-4o-mini", "openai/gpt-4.1-nano"]),
    verifiedPrices: [{ modelId: "gpt-4o-mini", input: 0.15, output: 0.6, sourceUrl: "https://openai.com/api/pricing/" }],
    openrouterPrices: new Map([["openai/gpt-4.1-nano", { input: 0.1, output: 0.4 }]]),
  });
  assert.deepEqual(linked.access.map((a) => a.externalModelId), ["gpt-4o-mini", "gpt-4.1-nano"]);
  assert.deepEqual(linked.prices.map((p) => p.status), ["verified", "estimated"]);
  assert.match(linked.prices[1].methodology, /not checked against OpenAI/);
});

test("Artificial Analysis benchmarks link only on an exact creator/slug match", () => {
  const b = normalizeArtificialAnalysis(
    [
      { slug: "gpt-4o-mini", name: "GPT-4o mini", model_creator: { slug: "openai", name: "OpenAI" }, evaluations: { artificial_analysis_intelligence_index: 36, artificial_analysis_coding_index: 23 } },
      { slug: "mystery-model", model_creator: { slug: "nobody" }, evaluations: { artificial_analysis_intelligence_index: 50 } },
    ],
    ["openai/gpt-4o-mini"]
  );
  const linked = b.filter((x) => x.modelSlug === "openai/gpt-4o-mini");
  assert.deepEqual(linked.map((x) => [x.metric, x.value]), [["intelligence_index", 36], ["coding_index", 23]]);
  assert.ok(b.filter((x) => x.sourceModelSlug === "nobody/mystery-model").every((x) => x.modelSlug === null));
});
