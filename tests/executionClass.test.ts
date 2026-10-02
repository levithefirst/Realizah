// P1 regression: OpenRouter ":batch" SKUs (asynchronous) entered the
// synchronous paid core, e.g. anthropic/claude-sonnet-5.5:batch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { baseModelId, executionClass, isInteractive, variantOf } from "../lib/registry/execution";
import { normalizeOpenRouterCatalog } from "../lib/registry/sources/openrouter";
import { selectCandidates } from "../lib/selection/select";
import { understandTask } from "../lib/task/understand";
import { access, DEFAULT_LIMITS, model } from "./fixtures";

const TASK = "Write a product update for our customers. Keep it under 100 words.";
const u = understandTask({ task: TASK, useCase: "writing" });
const OR = new Set(["openrouter"]);
const SONNET = "anthropic/claude-sonnet-5.5";

test("execution class: ':batch' is an asynchronous access path; plain and ':free' ids are interactive", () => {
  assert.equal(executionClass(`${SONNET}:batch`), "batch");
  assert.equal(executionClass(SONNET), "interactive");
  assert.equal(executionClass("qwen/qwen3.8-27b:free"), "interactive");
  assert.equal(executionClass("gpt-5-mini"), "interactive");
  assert.equal(isInteractive({ externalModelId: `${SONNET}:BATCH` }), false);
  // Realtime ids that merely contain a colon or the word stay as they are.
  assert.equal(executionClass("~openai/gpt-luna-latest"), "interactive");
  assert.equal(executionClass("acme/batch-writer"), "interactive");
  assert.equal(variantOf("acme/model:thinking"), null, "unknown variants are not collapsed");
  assert.equal(baseModelId(`${SONNET}:batch`), SONNET);
});

test("catalog: a ':batch' SKU is an access path of its model, not a separate model", () => {
  const row = (id: string, prompt: string, completion: string) => ({
    id,
    name: id.endsWith(":batch") ? "Claude Sonnet 5.5 (batch)" : "Claude Sonnet 5.5",
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: { prompt, completion },
  });
  const n = normalizeOpenRouterCatalog([row(`${SONNET}:batch`, "0.000001", "0.000005"), row(SONNET, "0.000002", "0.00001"), row("acme/only-batch:batch", "0.000001", "0.000002")]);
  assert.deepEqual(n.models.map((m) => m.slug).sort(), ["acme/only-batch", SONNET]);
  assert.equal(n.models.find((m) => m.slug === SONNET)!.name, "Claude Sonnet 5.5", "metadata from the realtime entry");
  assert.deepEqual(n.access.filter((a) => a.modelSlug === SONNET).map((a) => a.externalModelId).sort(), [SONNET, `${SONNET}:batch`]);
});

// 12 realtime models plus batch SKUs that are cheaper and more attractive.
function registry() {
  const creators = ["openai", "google", "deepseek", "qwen", "mistralai", "cohere"];
  const reg = Array.from({ length: 12 }, (_, i) => {
    const price = [0.05, 0.1, 0.2, 0.4, 0.8, 1.2, 1.5, 2, 2.5, 3, 3.2, 3.5][i];
    return model(`${creators[i % 6]}/m${i}`, { price: [price / 4, price] });
  });
  const attractive = { capabilities: ["reasoning", "text_generation"], releaseDate: "2026-09-30", benchmarks: { intelligence_index: 99 } };
  // Current shape: the batch SKU is an access path of the model, next to the realtime one.
  reg.push(model(SONNET, { ...attractive, access: [access("openrouter", `${SONNET}:batch`, 1, 5), access("openrouter", SONNET, 2, 10)] }));
  // Batch-only model.
  reg.push(model("anthropic/claude-batch-only", { ...attractive, access: [access("openrouter", "anthropic/claude-batch-only:batch", 0.1, 0.5)] }));
  // Legacy shape (rows created before normalization collapsed ":batch").
  reg.push(model("anthropic/claude-opus-5:batch", { ...attractive, access: [access("openrouter", "anthropic/claude-opus-5:batch", 0.2, 1)] }));
  return reg;
}

test("selection: no ':batch' route can enter the paid core, the expansion queue or screening", () => {
  const s = selectCandidates({ registry: registry(), understanding: u, providers: OR, limits: DEFAULT_LIMITS, taskText: TASK });
  const all = [...s.candidates, ...s.screening];
  assert.ok(s.candidates.length >= 4);
  assert.ok(all.every((c) => isInteractive(c.access)), all.map((c) => c.access.externalModelId).join(", "));
  assert.ok(!s.candidates.filter((c) => c.role === "core").some((c) => c.access.externalModelId.endsWith(":batch")));
  assert.ok(!s.candidates.filter((c) => c.role === "expansion").some((c) => c.access.externalModelId.endsWith(":batch")));
  assert.equal(s.excluded.batch_only, 2, "the batch-only model and the legacy batch row");
});

test("selection: a model with batch and realtime routes competes on its realtime route", () => {
  const s = selectCandidates({ registry: registry(), understanding: u, providers: OR, limits: { ...DEFAULT_LIMITS, maxCandidates: 20 }, taskText: TASK });
  const sonnet = s.candidates.find((c) => c.model.slug === SONNET);
  assert.ok(sonnet, "still selectable");
  assert.equal(sonnet!.access.externalModelId, SONNET);
  assert.equal(sonnet!.access.outputUsdPer1m, 10, "priced at the realtime rate, not the cheaper batch rate");
});
