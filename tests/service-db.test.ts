// End to end against Postgres (PGlite): refresh -> plan -> progressive run ->
// persisted audit trail. Providers and catalog are mocked; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./pglite";
import { refreshRegistry } from "../lib/registry/refresh";
import { planComparison, runComparison } from "../lib/comparison/service";

const TASK = "Write a product update for our customers. Keep it under 100 words.";
const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");

const creators = ["openai", "anthropic", "google", "deepseek", "qwen", "mistralai"];
const catalog = [
  ...Array.from({ length: 12 }, (_, i) => {
    const out = [0.05, 0.1, 0.2, 0.4, 0.8, 1.2, 2, 3, 4, 6, 8, 10][i];
    return {
      id: `${creators[i % 6]}/m${i}`,
      name: `M${i}`,
      created: 1767225600,
      context_length: 128000,
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      pricing: { prompt: String(out / 4 / 1e6), completion: String(out / 1e6) },
      top_provider: { context_length: 128000, max_completion_tokens: 16384 },
      supported_parameters: ["max_tokens"],
    };
  }),
  { id: "meta-llama/free-a:free", name: "Free A", created: 1767225600, context_length: 128000, architecture: { input_modalities: ["text"], output_modalities: ["text"] }, pricing: { prompt: "0", completion: "0" }, top_provider: { context_length: 128000, max_completion_tokens: 8192 }, supported_parameters: ["max_tokens"] },
];

test("a full comparison persists executed and skipped candidates with costs and reasons", async () => {
  const pg = await freshDb();
  delete process.env.OPENAI_API_KEY;
  delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  const chatBodies: { model: string; messages: unknown }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url.includes("/api/v1/models")) return Response.json({ data: catalog });
    if (url.includes("/chat/completions")) {
      const body = JSON.parse(String(init!.body));
      chatBodies.push({ model: body.model, messages: body.messages });
      return Response.json({ choices: [{ message: { content: words(80) }, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 110, total_tokens: 140 } });
    }
    return new Response("not mocked", { status: 500 });
  }) as typeof fetch;

  try {
    await refreshRegistry();
    const input = { toolInput: "ChatGPT", useCase: "writing", task: TASK, budgetUsd: 20, wordMaxOverride: null };
    const { plan, selection, product } = await planComparison(input);
    assert.equal(plan.executable, true, plan.reason ?? "");
    assert.equal(plan.outputTokenCeiling, 204);
    assert.equal(plan.screeningCount, 1);

    const dto = await runComparison(input, "iphash", selection!, plan.understanding, product);
    assert.equal(dto.attempted, 4, "meaningful after the core");
    assert.equal(dto.screeningRuns, 1);
    assert.ok(dto.skipped.length >= 6 && dto.skipped.every((s) => s.kind === "meaningful"));
    assert.ok(dto.chargedExecutionCostUsd <= 0.03);
    assert.ok(dto.results.some((r) => r.cheaperCost) && dto.results.some((r) => r.betterCost));
    assert.ok(dto.results.filter((r) => !r.labelEligible).every((r) => !r.cheaperCost && !r.betterCost && r.budget === null));
    assert.ok(chatBodies.every((b) => JSON.stringify(b.messages) === JSON.stringify([{ role: "user", content: TASK }])));

    const run = (await pg.query<any>(`select * from comparison_runs where id = $1`, [dto.runId])).rows[0];
    assert.equal(run.models_attempted, 4);
    assert.equal(run.screening_runs, 1);
    assert.equal(run.candidates_skipped, dto.skipped.length);
    assert.equal(run.output_token_ceiling, 204);
    assert.match(run.stop_reason, /Meaningful/);
    assert.ok(Number(run.charged_execution_cost_usd) <= 0.03);
    assert.ok(Number(run.peak_committed_usd) <= 0.03);
    const counts = (await pg.query<{ status: string; role: string; n: number }>(
      `select status, role, count(*)::int as n from comparison_candidates where run_id = $1 group by 1, 2 order by 1, 2`,
      [dto.runId]
    )).rows;
    const n = (status: string, role: string) => counts.find((c) => c.status === status && c.role === role)?.n ?? 0;
    assert.equal(n("executed", "core"), 4);
    assert.equal(n("executed", "free_screening"), 1);
    assert.equal(n("skipped", "expansion"), dto.skipped.length);
    const skippedRow = (await pg.query<any>(`select skip_reason, worst_case_cost_usd, expected_cost_usd from comparison_candidates where run_id = $1 and status = 'skipped' limit 1`, [dto.runId])).rows[0];
    assert.match(skippedRow.skip_reason, /^meaningful:/);
    assert.ok(Number(skippedRow.worst_case_cost_usd) > 0 && Number(skippedRow.expected_cost_usd) > 0);
    const results = (await pg.query<{ n: number }>(`select count(*)::int as n from comparison_results where run_id = $1`, [dto.runId])).rows[0].n;
    assert.equal(results, 5);
    const budgets = (await pg.query<{ n: number }>(`select count(*)::int as n from budget_plans where run_id = $1`, [dto.runId])).rows[0].n;
    assert.equal(budgets, 4, "no budget line for free screening");
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.OPENROUTER_API_KEY;
  }
});
