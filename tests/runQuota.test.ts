// P0 regression: a run where every provider call failed authentication still
// used one of the user's free comparisons. Driven through the real /api/run
// handler against Postgres (PGlite); providers and catalog are mocked.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./pglite";
import { refreshRegistry } from "../lib/registry/refresh";
import { resetProviderHealth } from "../lib/providers/readiness";
import { clientIp, hashIp, refundToken, takeToken } from "../lib/ratelimit";
import { POST } from "../app/api/run/route";

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
    };
  }),
  { id: "anthropic/claude-sonnet-5.5:batch", name: "Sonnet (batch)", created: 1790000000, context_length: 200000, architecture: { input_modalities: ["text"], output_modalities: ["text"] }, pricing: { prompt: "0.0000001", completion: "0.0000005" }, top_provider: { context_length: 200000, max_completion_tokens: 16384 } },
];

type Mode = { probe: "ok" | "auth_failed"; chat: "ok" | "auth_failed" };
let mode: Mode;
let chatCalls: string[];
const realFetch = globalThis.fetch;
const IP = "203.0.113.7";

function request(body: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/run", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `${IP}, 10.0.0.1` },
    body: JSON.stringify({ tool: "ChatGPT", useCase: "writing", task: TASK, ...body }),
  });
}
const used = async (pg: Awaited<ReturnType<typeof freshDb>>) =>
  (await pg.query<{ count: number }>(`select count from rate_limits where id = $1`, [hashIp(IP)])).rows[0]?.count ?? 0;

let pg: Awaited<ReturnType<typeof freshDb>>;
beforeEach(async () => {
  pg = await freshDb();
  resetProviderHealth();
  process.env.DATABASE_URL = "postgres://test-only";
  process.env.OPENROUTER_API_KEY = "sk-or-v1-test";
  delete process.env.OPENAI_API_KEY;
  delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
  process.env.FREE_COMPARISONS_PER_DAY = "3";
  mode = { probe: "ok", chat: "ok" };
  chatCalls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/v1/models")) return Response.json({ data: catalog });
    if (url.endsWith("/api/v1/key")) {
      return mode.probe === "ok" ? Response.json({ data: { label: "test" } }) : Response.json({ error: { message: "Missing Authentication header", code: 401 } }, { status: 401 });
    }
    if (url.includes("/chat/completions")) {
      chatCalls.push(JSON.parse(String(init!.body)).model);
      if (mode.chat === "auth_failed") return Response.json({ error: { message: "Missing Authentication header", code: 401 } }, { status: 401 });
      return Response.json({ choices: [{ message: { content: words(80) }, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 110, total_tokens: 140 } });
    }
    return new Response("not mocked", { status: 500 });
  }) as typeof fetch;
  await refreshRegistry();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.DATABASE_URL;
  delete process.env.OPENROUTER_API_KEY;
});

test("a successful comparison uses exactly one free comparison", async () => {
  const res = await POST(request());
  const body = await res.json();
  assert.equal(res.status, 200, body.error);
  assert.equal(body.systemicFailure, null);
  assert.equal(body.quotaRefunded, false);
  assert.equal(body.remaining, 2);
  assert.equal(await used(pg), 1);
  assert.ok(!chatCalls.some((m) => m.endsWith(":batch")), "no batch SKU was called");
});

test("every call fails authentication: the run stops early and does not use a free comparison", async () => {
  mode.chat = "auth_failed"; // the probe passes, the real calls don't
  const res = await POST(request());
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.match(body.systemicFailure, /openrouter failed \(auth: Missing Authentication header\)/);
  assert.equal(body.quotaRefunded, true);
  assert.equal(body.remaining, 3);
  assert.equal(await used(pg), 0);
  assert.match(body.summary, /did not use one of your free comparisons/);
  assert.ok(chatCalls.filter((m) => !m.endsWith(":free")).length <= 1, `paid calls: ${chatCalls.join(", ")}`);
  assert.match(body.stopReason, /Stopped early/);
  // The audit trail still records the run.
  const run = (await pg.query<any>(`select stop_reason, models_succeeded from comparison_runs where id = $1`, [body.runId])).rows[0];
  assert.match(run.stop_reason, /Stopped early/);
  assert.equal(run.models_succeeded, 0);

  // The next request already knows the key is rejected: nothing runs, nothing is charged.
  const again = await POST(request());
  const againBody = await again.json();
  assert.equal(again.status, 503);
  assert.match(againBody.error, /No model provider is available/);
  assert.equal(await used(pg), 0);
});

test("the auth probe rejects the key: 503 before any model call or quota use", async () => {
  mode.probe = "auth_failed";
  const res = await POST(request());
  const body = await res.json();
  assert.equal(res.status, 503);
  assert.match(body.error, /Your free comparison was not used/);
  assert.equal(body.providers[0].state, "auth_failed");
  assert.equal(chatCalls.length, 0);
  assert.equal(await used(pg), 0);
});

test("a server error after the quota was taken gives it back (once)", async () => {
  await pg.exec(`drop table budget_plans; drop table comparison_results; drop table comparison_candidates; drop table comparison_runs cascade;`);
  const res = await POST(request());
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /Your free comparison was not used/);
  assert.equal(await used(pg), 0);
});

test("refunds never go below zero, never cross into a new window, and only undo one take", async () => {
  const h = hashIp(clientIp(new Headers({ "x-forwarded-for": IP })));
  const a = await takeToken(h);
  const b = await takeToken(h);
  assert.equal(b.count, 2);
  assert.equal(await refundToken(h, b.windowKey), 1);
  assert.equal(await refundToken(h, a.windowKey), 0);
  assert.equal(await refundToken(h, a.windowKey), null, "already at zero");
  assert.equal(await refundToken(h, "2001-01-01 00:00:00+00"), null, "a stale window is never refunded");
  // Concurrent takes and refunds stay consistent.
  const takes = await Promise.all([1, 2, 3].map(() => takeToken(h)));
  await Promise.all(takes.map((t) => refundToken(h, t.windowKey)));
  assert.equal(await used(pg), 0);
});

test("over the limit: refused without running, and no refund inflates the allowance", async () => {
  process.env.FREE_COMPARISONS_PER_DAY = "1";
  assert.equal((await POST(request())).status, 200);
  const before = chatCalls.length;
  const res = await POST(request());
  assert.equal(res.status, 429);
  assert.equal(chatCalls.length, before);
  assert.equal(await used(pg), 2, "the refused attempt is counted, not refunded");
});
