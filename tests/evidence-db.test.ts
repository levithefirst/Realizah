// Phase 2 evidence against Postgres (PGlite): billing fields on each result,
// stored replies and full check wording, the operator export, and retention
// that deletes typed content while keeping anonymous measurements.
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./pglite";
import { refreshRegistry } from "../lib/registry/refresh";
import { applyRetention, planComparison, runComparison } from "../lib/comparison/service";
import { GET as exportGET } from "../app/api/export/route";

const MAYA = "Return ONLY valid JSON with fields name, age, and city for a fictional person named Maya who is 29 and lives in Lagos.";
const row = (id: string, prompt: number, completion: number) => ({
  id,
  name: id,
  created: 1790000000,
  context_length: 128000,
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  pricing: { prompt: String(prompt / 1e6), completion: String(completion / 1e6) },
  top_provider: { context_length: 128000, max_completion_tokens: 16384 },
  supported_parameters: ["max_tokens"],
});
const catalog = [row("upstage/solar-mini4", 0.05, 0.2), row("perceptron/perceptron-mk1.5", 0.15, 1.5), row("cohere/command-a-plus", 0.3, 1.5), row("qwen/qwen3.7-flash", 0.03, 0.13)];
const REPLY = '{"name":"Maya","age":29,"city":"Lagos"}';
const get = (qs = "", token?: string) =>
  exportGET(new Request(`http://localhost/api/export${qs}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }));

test("evidence: billing fields, stored replies, export, and content-only retention", async () => {
  const pg = await freshDb();
  delete process.env.OPENAI_API_KEY;
  delete process.env.EXPORT_TOKEN;
  process.env.DATABASE_URL = "postgres://test-only";
  process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (url.endsWith("/api/v1/models")) return Response.json({ data: catalog });
    if (url.includes("/chat/completions")) {
      return Response.json({ choices: [{ message: { content: REPLY }, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60, cost: 0.0000123 } });
    }
    return new Response("not mocked", { status: 500 });
  }) as typeof fetch;

  try {
    await refreshRegistry();
    const input = { toolInput: "My secret tool", useCase: "private use case", task: MAYA, budgetUsd: null, wordMaxOverride: null };
    const { plan, selection, product } = await planComparison(input);
    assert.deepEqual(plan.understanding.constraints.requiredFields, ["name", "age", "city"]);
    const dto = await runComparison(input, "iphash-1", selection!, plan.understanding, product);

    // BLOCKER regression, end to end: valid JSON passes.
    const paid = dto.results.filter((r) => r.labelEligible);
    assert.ok(paid.length >= 2 && paid.every((r) => r.passed), JSON.stringify(paid.map((r) => r.checks)));

    // #3: the result carries the billing audit.
    for (const r of paid) {
      assert.equal(typeof r.reservedCostUsd, "number");
      assert.ok(r.reservedCostUsd > 0);
      assert.equal(r.providerReportedCostUsd, 0.0000123);
      assert.equal(r.billedCostUsd, Math.max(r.estimatedCostUsd ?? 0, 0.0000123));
      assert.equal(r.overReservation, false);
    }

    // #6: replies and full check wording are stored; permanent checks are content-free.
    const stored = (await pg.query<any>(`select output_text, checks from comparison_outputs where run_id = $1`, [dto.runId])).rows;
    assert.equal(stored.length, dto.results.length);
    assert.ok(stored.every((s) => s.output_text === REPLY));

    // #2: export is off without a token, refuses a wrong one, and serves the evidence with the right one.
    assert.equal((await get()).status, 404);
    process.env.EXPORT_TOKEN = "export-test-token";
    assert.equal((await get()).status, 401);
    assert.equal((await get("", "wrong")).status, 401);
    const res = await get("?limit=10", "export-test-token");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.count, 1);
    const run = body.runs[0];
    assert.equal(run.runId, dto.runId);
    assert.equal(run.task, MAYA);
    assert.equal(run.contentDeleted, false);
    assert.ok(!JSON.stringify(body).includes("iphash-1"), "never the IP hash");
    const executed = run.candidates.filter((c: any) => c.status === "executed");
    assert.ok(executed.every((c: any) => c.result.output === REPLY && c.result.reservedCostUsd > 0 && c.result.billedCostUsd > 0));
    assert.equal(run.candidates.length, dto.results.length + dto.skipped.length, "every executed and skipped candidate is exported");
    assert.ok(executed[0].result.checks.some((ch: any) => ch.rule === "json_fields.v1" && ch.detail === "All 3 fields present."));
    assert.equal((await get("?limit=0", "export-test-token")).status, 400);

    // Retention after 14 days: content goes, measurements stay.
    await pg.query(`update comparison_runs set created_at = now() - interval '15 days'`);
    await pg.query(`update comparison_outputs set created_at = now() - interval '15 days'`);
    await applyRetention();
    const scrubbed = (await pg.query<any>(`select * from comparison_runs where id = $1`, [dto.runId])).rows[0];
    assert.ok(scrubbed, "the run is kept");
    assert.deepEqual([scrubbed.task_text, scrubbed.ai_tool_input, scrubbed.use_case, scrubbed.ip_hash], ["", "", "", null]);
    assert.ok(scrubbed.content_deleted_at);
    assert.deepEqual(scrubbed.task_understanding.constraints.requiredFields, []);
    assert.equal(scrubbed.task_understanding.primary, "structured_json", "the category is kept");
    assert.equal(scrubbed.baseline.product, "", "an unrecognised tool name is what the person typed");
    assert.equal((await pg.query<any>(`select count(*)::int as n from comparison_outputs`)).rows[0].n, 0);
    const kept = (await pg.query<any>(`select count(*)::int as n, bool_and(passed) as passed from comparison_results where run_id = $1`, [dto.runId])).rows[0];
    assert.equal(kept.n, dto.results.length);
    const permanent = JSON.stringify((await pg.query<any>(`select evaluation from comparison_results where run_id = $1`, [dto.runId])).rows);
    assert.ok(!permanent.includes("Maya") && !permanent.includes("Lagos"), "no task or reply text in permanent rows");
    // Idempotent.
    await applyRetention();
    const after = await (await get("", "export-test-token")).json();
    assert.equal(after.runs[0].contentDeleted, true);
    assert.equal(after.runs[0].task, "");
    assert.ok(after.runs[0].candidates.filter((c: any) => c.result).every((c: any) => c.result.output === null && c.result.passed !== null));
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.EXPORT_TOKEN;
    delete process.env.DATABASE_URL;
  }
});
