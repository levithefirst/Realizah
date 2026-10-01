// Integration: refresh job + registry loader against real Postgres (PGlite),
// with the source APIs mocked. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./pglite";
import { refreshRegistry } from "../lib/registry/refresh";
import { loadRegistry } from "../lib/registry/load";
import { selectCandidates } from "../lib/selection/select";
import { understandTask } from "../lib/task/understand";
import { LIMITS } from "./fixtures";

const row = (id: string, input: string, output: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  created: 1767225600,
  context_length: 200000,
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  pricing: { prompt: input, completion: output },
  top_provider: { context_length: 200000, max_completion_tokens: 16384 },
  supported_parameters: ["max_tokens", "temperature", "tools"],
  ...extra,
});

function catalogFetch(rows: unknown[], opts: { openaiIds?: string[]; failCatalog?: boolean } = {}): typeof fetch {
  return (async (url: string) => {
    if (url.includes("openrouter.ai/api/v1/models")) {
      if (opts.failCatalog) return new Response("down", { status: 503 });
      return Response.json({ data: rows });
    }
    if (url.includes("api.openai.com/v1/models")) return Response.json({ data: (opts.openaiIds ?? []).map((id) => ({ id })) });
    return new Response("not mocked", { status: 500 });
  }) as unknown as typeof fetch;
}

const CATALOG = [
  row("openai/gpt-4o-mini", "0.00000015", "0.0000006"),
  row("anthropic/claude-x", "0.000003", "0.000015"),
  row("google/gemini-y", "0.0000001", "0.0000004"),
  row("deepseek/ds-z", "0.00000027", "0.0000011"),
  row("meta-llama/llama-w:free", "0", "0"),
  row("openrouter/auto", "-1", "-1"),
  row("acme/painter", "0.000001", "0.000001", { architecture: { input_modalities: ["text"], output_modalities: ["image"] } }),
];

test("refresh ingests the catalog, versions prices, preserves history and marks stale", async () => {
  const pg = await freshDb();
  process.env.OPENAI_API_KEY = "test";
  delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;

  const r1 = await refreshRegistry({ fetchImpl: catalogFetch(CATALOG, { openaiIds: ["gpt-4o-mini", "whisper-1"] }) });
  assert.equal(r1.status, "ok");
  assert.equal(r1.sources.artificial_analysis.status, "skipped");
  const models = (await pg.query<{ slug: string }>("select slug from models order by slug")).rows.map((x) => x.slug);
  assert.deepEqual(models, ["acme/painter", "anthropic/claude-x", "deepseek/ds-z", "google/gemini-y", "meta-llama/llama-w", "openai/gpt-4o-mini"]);
  // gpt-4o-mini: OpenRouter path + direct OpenAI path with the hand-verified price.
  const direct = await pg.query<{ price_status: string; input_usd_per_1m: string }>(
    `select p.price_status, p.input_usd_per_1m from model_prices p join model_provider_access a on a.id = p.access_id
      where a.provider_id = 'openai' and a.external_model_id = 'gpt-4o-mini'`
  );
  assert.deepEqual([direct.rows[0].price_status, Number(direct.rows[0].input_usd_per_1m)], ["verified", 0.15]);
  const tools = (await pg.query<{ capability: string }>(`select c.capability from model_capabilities c join models m on m.id = c.model_id where m.slug = 'anthropic/claude-x' order by 1`)).rows.map((x) => x.capability);
  assert.deepEqual(tools, ["text_generation", "tool_use"]);

  // Second refresh: one price change, one model gone.
  const changed = CATALOG.filter((x) => (x as { id: string }).id !== "deepseek/ds-z").map((x) =>
    (x as { id: string }).id === "anthropic/claude-x" ? row("anthropic/claude-x", "0.0000025", "0.000015") : x
  );
  const r2 = await refreshRegistry({ fetchImpl: catalogFetch(changed, { openaiIds: ["gpt-4o-mini"] }) });
  assert.equal(r2.pricesChanged, 1);
  const history = (await pg.query<{ input_usd_per_1m: string }>(
    `select p.input_usd_per_1m from model_prices p join model_provider_access a on a.id = p.access_id
      where a.external_model_id = 'anthropic/claude-x' order by p.observed_at`
  )).rows.map((x) => Number(x.input_usd_per_1m));
  assert.deepEqual(history, [3, 2.5], "old price kept, new price added");
  const ds = await pg.query<{ status: string }>(`select status from models where slug = 'deepseek/ds-z'`);
  assert.equal(ds.rows[0].status, "stale", "unseen model is marked stale, not deleted");

  // A failing source leaves the last snapshot usable.
  const r3 = await refreshRegistry({ fetchImpl: catalogFetch([], { failCatalog: true, openaiIds: ["gpt-4o-mini"] }) });
  assert.equal(r3.sources.openrouter_catalog.status, "error");
  const active = (await pg.query<{ n: number }>(`select count(*)::int as n from models where status = 'active'`)).rows[0].n;
  assert.equal(active, 5);
});

test("loader + selection on the ingested registry", async () => {
  await freshDb();
  process.env.OPENAI_API_KEY = "test";
  await refreshRegistry({ fetchImpl: catalogFetch(CATALOG, { openaiIds: ["gpt-4o-mini"] }) });
  const registry = await loadRegistry();
  const mini = registry.find((m) => m.slug === "openai/gpt-4o-mini")!;
  assert.deepEqual(mini.access.map((a) => a.providerId).sort(), ["openai", "openrouter"]);
  assert.equal(mini.access.find((a) => a.providerId === "openrouter")!.inputUsdPer1m, 0.15);

  const u = understandTask({ task: "Write a 300-word blog post about tea.", useCase: "blogging" });
  const viaOR = selectCandidates({ registry, understanding: u, providers: new Set(["openrouter"]), limits: LIMITS });
  assert.deepEqual(viaOR.candidates.map((c) => c.model.slug).sort(), ["anthropic/claude-x", "deepseek/ds-z", "google/gemini-y", "openai/gpt-4o-mini"]);
  // Only the OpenAI key: only the direct OpenAI path is executable.
  const viaOpenAI = selectCandidates({ registry, understanding: u, providers: new Set(["openai"]), limits: LIMITS });
  assert.deepEqual(viaOpenAI.candidates.map((c) => `${c.model.slug} via ${c.access.providerId}`), ["openai/gpt-4o-mini via openai"]);
  assert.equal(viaOpenAI.excluded.no_configured_provider, 4);
});

test("comparison results are immutable once written", async () => {
  const pg = await freshDb();
  await pg.exec(`insert into models (slug, creator, name, source) values ('a/b', 'a', 'b', 't')`);
  await pg.exec(`insert into model_provider_access (model_id, provider_id, external_model_id, source) select id, 'openrouter', 'a/b', 't' from models`);
  const run = await pg.query<{ id: string }>(
    `insert into comparison_runs (ai_tool_input, use_case, task_text, task_understanding, baseline, execution_budget_usd, candidate_count)
     values ('ChatGPT', 'x', 'y', '{}', '{}', 0.1, 1) returning id`
  );
  const cand = await pg.query<{ id: string }>(
    `insert into comparison_candidates (run_id, model_id, access_id, provider_id, external_model_id, price_status, selection_rank, selection_reason, max_output_tokens)
     select $1, m.id, a.id, 'openrouter', 'a/b', 'verified', 1, 'r', 100 from models m join model_provider_access a on a.model_id = m.id returning id`,
    [run.rows[0].id]
  );
  await pg.query(`insert into comparison_results (run_id, candidate_id, executed, estimated_cost_usd) values ($1, $2, true, 0.001)`, [run.rows[0].id, cand.rows[0].id]);
  await assert.rejects(pg.query(`update comparison_results set estimated_cost_usd = 0`), /immutable/);
  await assert.rejects(pg.query(`update comparison_candidates set selection_rank = 2`), /immutable/);
});
