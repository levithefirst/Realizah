// End to end against Postgres (PGlite): an overbilling route is persisted,
// raises its reservation in the next plan, and is back to normal once the
// observation leaves the window. Also: the wordMax instruction reaches the
// model, and a failed free screening run doesn't make a run "partial".
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./pglite";
import { refreshRegistry } from "../lib/registry/refresh";
import { planComparison, runComparison } from "../lib/comparison/service";
import { loadRouteBillingHistory } from "../lib/comparison/billingHistory";

const TASK = "Explain the benefits of remote work for small teams.";
const SOL = "openai/gpt-6.1-sol-pro";
const row = (id: string, prompt: number, completion: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  created: 1790000000,
  context_length: 128000,
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  pricing: { prompt: String(prompt / 1e6), completion: String(completion / 1e6) },
  top_provider: { context_length: 128000, max_completion_tokens: 16384 },
  supported_parameters: ["max_tokens"],
  ...extra,
});
// Four paid models (so all four are the core) and one free screening model.
const catalog = [
  row("upstage/solar-mini4", 0.05, 0.2),
  row("perceptron/perceptron-mk1.5", 0.15, 1.5),
  row("cohere/command-a-plus", 0.3, 1.5),
  row(SOL, 2, 10, { supported_parameters: ["max_tokens", "reasoning"] }),
  row("apodex/apodex-1.1-mini:free", 0, 0),
];
const reply = Array.from({ length: 20 }, () => "word").join(" ");

test("billing safety end to end: record, raise the reservation, expire after the window", async () => {
  const pg = await freshDb();
  delete process.env.OPENAI_API_KEY;
  delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
  process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
  const realFetch = globalThis.fetch;
  const sent: { model: string; content: string }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/v1/models")) return Response.json({ data: catalog });
    if (url.includes("/chat/completions")) {
      const body = JSON.parse(String(init!.body));
      sent.push({ model: body.model, content: body.messages[0].content });
      if (body.model.endsWith(":free")) return Response.json({ error: { message: "Provider returned an empty response" } }, { status: 502 });
      if (body.model === SOL) {
        return Response.json({ choices: [{ message: { content: reply }, finish_reason: "length" }], usage: { prompt_tokens: 1843, completion_tokens: 455, total_tokens: 2298, cost: 0.008236 } });
      }
      return Response.json({ choices: [{ message: { content: reply }, finish_reason: "stop" }], usage: { prompt_tokens: 25, completion_tokens: 30, total_tokens: 55 } });
    }
    return new Response("not mocked", { status: 500 });
  }) as typeof fetch;

  try {
    await refreshRegistry();
    const input = { toolInput: "ChatGPT", useCase: "writing", task: TASK, budgetUsd: null, wordMaxOverride: 25 };
    const { plan, selection, product } = await planComparison(input);
    assert.equal(plan.executable, true, plan.reason ?? "");
    const solPlanned = selection!.candidates.find((c) => c.model.slug === SOL)!;
    assert.ok(Math.abs(solPlanned.worstCaseCostUsd - 0.002116) < 1e-6);

    const dto = await runComparison(input, "iphash", selection!, plan.understanding, product);

    // wordMax reaches every model as an instruction after the unchanged task.
    assert.ok(sent.length >= 5);
    assert.ok(sent.every((s) => s.content === `${TASK}\n\nKeep the response to 25 words or fewer.`));

    // The overrun is in the result, the stop reason and the database.
    assert.equal(dto.billingOverruns.length, 1);
    assert.equal(dto.billingOverruns[0].externalModelId, SOL);
    assert.match(dto.stopReason, /Meaningful comparison reached.* Cost control: openai\/gpt-6\.1-sol-pro via openrouter billed \$0\.00824 against \$0\.00212 reserved/);
    const rows = (await pg.query<any>(
      `select c.external_model_id, res.reserved_cost_usd, res.billed_cost_usd, res.over_reservation
         from comparison_results res join comparison_candidates c on c.id = res.candidate_id where res.run_id = $1`,
      [dto.runId]
    )).rows;
    const sol = rows.find((r) => r.external_model_id === SOL);
    assert.equal(sol.over_reservation, true);
    assert.ok(Math.abs(Number(sol.reserved_cost_usd) - 0.002116) < 1e-6);
    assert.equal(Number(sol.billed_cost_usd), 0.008236);
    assert.equal(rows.filter((r) => r.over_reservation).length, 1, "clean calls are not flagged");
    const run = (await pg.query<any>(`select status, stop_reason from comparison_runs where id = $1`, [dto.runId])).rows[0];
    assert.match(run.stop_reason, /Cost control:/);
    // Only the free screening run failed: the paid comparison is complete.
    assert.ok(dto.results.some((r) => r.role === "free_screening" && !r.executed));
    assert.equal(run.status, "complete");

    // Next plan: the route reserves its observed ratio x margin; at the
    // default $0.01 per-model cap that no longer fits, so it is not launched.
    const history = await loadRouteBillingHistory();
    assert.equal(history.size, 1);
    const [h] = [...history.values()];
    assert.ok(h.maxRatio > 3.8 && h.maxRatio < 4);
    const next = await planComparison(input);
    assert.ok(!next.selection!.candidates.some((c) => c.model.slug === SOL));
    assert.ok((next.selection!.excluded.excessive_cost ?? 0) >= 1);

    // Not a permanent blacklist: once the observation is older than the window,
    // the route plans normally again.
    await pg.query(`update comparison_runs set created_at = now() - interval '8 days'`);
    assert.equal((await loadRouteBillingHistory()).size, 0);
    const later = await planComparison(input);
    const back = later.selection!.candidates.find((c) => c.model.slug === SOL)!;
    assert.ok(back);
    assert.equal(back.reservationFactor, 1);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.OPENROUTER_API_KEY;
  }
});
