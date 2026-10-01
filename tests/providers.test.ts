import { test } from "node:test";
import assert from "node:assert/strict";
import { openRouterAdapter } from "../lib/providers/openrouter";
import { openAIAdapter } from "../lib/providers/openai";
import { configuredAdapters } from "../lib/providers";

type Captured = { url: string; init: RequestInit };
function mockFetch(status: number, body: unknown, captured: Captured[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    captured.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

const OK = {
  choices: [{ message: { content: "Hello there" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, cost: 0.0000042 },
};

test("OpenRouter adapter sends the request as given and normalizes the result", async () => {
  const captured: Captured[] = [];
  const a = openRouterAdapter({ apiKey: "test-key", fetchImpl: mockFetch(200, OK, captured) });
  const messages = [{ role: "user" as const, content: "  exact task\n" }];
  const r = await a.run({ externalModelId: "anthropic/claude-x", messages, maxTokens: 500, timeoutMs: 1000 });
  assert.equal(captured[0].url, "https://openrouter.ai/api/v1/chat/completions");
  const body = JSON.parse(String(captured[0].init.body));
  assert.equal(body.model, "anthropic/claude-x");
  assert.deepEqual(body.messages, messages);
  assert.equal(body.max_tokens, 500);
  assert.equal("temperature" in body, false);
  assert.deepEqual(body.usage, { include: true });
  assert.equal((captured[0].init.headers as Record<string, string>).authorization, "Bearer test-key");
  assert.deepEqual(
    { ok: r.ok, text: r.text, inputTokens: r.inputTokens, outputTokens: r.outputTokens, totalTokens: r.totalTokens, finishReason: r.finishReason, providerReportedCostUsd: r.providerReportedCostUsd },
    { ok: true, text: "Hello there", inputTokens: 12, outputTokens: 3, totalTokens: 15, finishReason: "stop", providerReportedCostUsd: 0.0000042 }
  );
});

test("OpenAI adapter uses max_completion_tokens", async () => {
  const captured: Captured[] = [];
  const a = openAIAdapter({ apiKey: "k", fetchImpl: mockFetch(200, OK, captured) });
  await a.run({ externalModelId: "gpt-4o-mini", messages: [{ role: "user", content: "x" }], maxTokens: 300, timeoutMs: 1000 });
  const body = JSON.parse(String(captured[0].init.body));
  assert.equal(body.max_completion_tokens, 300);
  assert.equal(captured[0].url, "https://api.openai.com/v1/chat/completions");
});

test("provider errors are normalized", async () => {
  const notFound = await openRouterAdapter({ apiKey: "k", fetchImpl: mockFetch(404, { error: { message: "no such model" } }) }).run({ externalModelId: "x/y", messages: [], maxTokens: 1, timeoutMs: 1000 });
  assert.deepEqual([notFound.ok, notFound.errorKind, notFound.error], [false, "not_found", "no such model"]);
  const limited = await openRouterAdapter({ apiKey: "k", fetchImpl: mockFetch(429, {}) }).run({ externalModelId: "x/y", messages: [], maxTokens: 1, timeoutMs: 1000 });
  assert.equal(limited.errorKind, "rate_limited");
  const inBody = await openRouterAdapter({ apiKey: "k", fetchImpl: mockFetch(200, { error: { message: "upstream failed" } }) }).run({ externalModelId: "x/y", messages: [], maxTokens: 1, timeoutMs: 1000 });
  assert.equal(inBody.ok, false);
});

test("timeouts are reported as timeouts", async () => {
  const hang = (async (_u: string, init: RequestInit) =>
    new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("t"), { name: "TimeoutError" }))))) as unknown as typeof fetch;
  // AbortSignal.timeout timers don't keep Node alive; a server request does.
  const keepAlive = setTimeout(() => {}, 1000);
  const r = await openRouterAdapter({ apiKey: "k", fetchImpl: hang }).run({ externalModelId: "x/y", messages: [], maxTokens: 1, timeoutMs: 20 });
  clearTimeout(keepAlive);
  assert.deepEqual([r.ok, r.errorKind], [false, "timeout"]);
});

test("adapters without a key are not configured", () => {
  const map = configuredAdapters([openRouterAdapter({ apiKey: "" }), openAIAdapter({ apiKey: "k" })]);
  assert.deepEqual([...map.keys()], ["openai"]);
});
