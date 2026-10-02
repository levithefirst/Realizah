// P0 regression: a present-but-unusable key must not make a provider look
// configured, the Authorization header must carry the cleaned key, and no
// key may leak into stored errors or logs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readCredential } from "../lib/providers/credentials";
import { openRouterAdapter } from "../lib/providers/openrouter";
import { openAIAdapter } from "../lib/providers/openai";
import { configuredAdapters } from "../lib/providers";
import { errorForLog, redact } from "../lib/redact";
import { caughtFailure } from "../lib/providers/types";

const KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";

test("credentials: blank, whitespace, placeholder and malformed values are not usable keys", () => {
  assert.deepEqual(readCredential(undefined), { key: null, issue: "missing" });
  assert.deepEqual(readCredential(""), { key: null, issue: "missing" });
  for (const v of [" ", "   \n", "\t", '""', "''", "Bearer ", "  bearer  "]) assert.equal(readCredential(v).issue, "blank", JSON.stringify(v));
  for (const v of ["your_openrouter_api_key", "<OPENROUTER_API_KEY>", "${OPENROUTER_API_KEY}", "undefined", "null", "xxxx", "changeme"]) {
    assert.equal(readCredential(v).issue, "placeholder", v);
  }
  for (const v of ["sk-or-v1 abc", "sk-or\nv1", "sk-or-v1-ключ", "sk​or"]) assert.equal(readCredential(v).issue, "malformed", JSON.stringify(v));
});

test("credentials: common paste mistakes are cleaned, not rejected", () => {
  for (const v of [KEY, ` ${KEY}\n`, `"${KEY}"`, `'${KEY}'`, `Bearer ${KEY}`, ` "Bearer ${KEY}" `]) {
    assert.deepEqual(readCredential(v), { key: KEY, issue: null }, JSON.stringify(v));
  }
});

test("adapters: a whitespace-only key is not configured (it used to be, and every call failed)", () => {
  const map = configuredAdapters([openRouterAdapter({ apiKey: "  \n" }), openAIAdapter({ apiKey: '""' })]);
  assert.equal(map.size, 0);
  assert.match(openRouterAdapter({ apiKey: " " }).configIssue!()!, /OPENROUTER_API_KEY is set but empty/);
  assert.equal(openRouterAdapter({ apiKey: KEY }).configIssue!(), null);
});

test("adapters: the Authorization header always carries the cleaned key", async () => {
  const seen: Record<string, string>[] = [];
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    seen.push(init.headers as Record<string, string>);
    return Response.json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} });
  }) as unknown as typeof fetch;
  await openRouterAdapter({ apiKey: `"Bearer ${KEY}"\n`, fetchImpl }).run({ externalModelId: "x/y", messages: [], maxTokens: 1, timeoutMs: 1000 });
  await openAIAdapter({ apiKey: ` ${KEY} `, fetchImpl }).run({ externalModelId: "gpt-x", messages: [], maxTokens: 1, timeoutMs: 1000 });
  assert.equal(seen[0].authorization, `Bearer ${KEY}`);
  assert.equal(seen[1].authorization, `Bearer ${KEY}`);
});

test("OpenRouter's 'Missing Authentication header' 401 is classified as an auth failure", async () => {
  const fetchImpl = (async () => Response.json({ error: { message: "Missing Authentication header", code: 401 } }, { status: 401 })) as unknown as typeof fetch;
  const r = await openRouterAdapter({ apiKey: KEY, fetchImpl }).run({ externalModelId: "x/y", messages: [], maxTokens: 1, timeoutMs: 1000 });
  assert.deepEqual([r.ok, r.errorKind, r.error], [false, "auth", "Missing Authentication header"]);
});

test("auth probes hit non-billable endpoints with GET and the cleaned key", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return url.includes("openrouter") ? Response.json({ data: { label: "x" } }) : Response.json({ error: { message: "Incorrect API key provided: sk-proj-****abcd" } }, { status: 401 });
  }) as unknown as typeof fetch;
  const or = await openRouterAdapter({ apiKey: ` ${KEY}`, fetchImpl }).checkAuth!();
  const oa = await openAIAdapter({ apiKey: KEY, fetchImpl }).checkAuth!();
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/key");
  assert.equal(calls[1].url, "https://api.openai.com/v1/models");
  assert.ok(calls.every((c) => c.init.method === "GET" && !c.init.body));
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, `Bearer ${KEY}`);
  assert.deepEqual(or, { state: "ok", detail: null });
  assert.equal(oa.state, "auth_failed");
  assert.ok(!oa.detail!.includes("sk-proj"), "provider's echo of the key is redacted");
  const down = await openRouterAdapter({ apiKey: KEY, fetchImpl: (async () => new Response("bad gateway", { status: 502 })) as unknown as typeof fetch }).checkAuth!();
  assert.equal(down.state, "unreachable");
});

test("no key reaches stored errors or logs", () => {
  const undici = new TypeError(`Headers.append: "Bearer ${KEY}\n" is an invalid header value.`);
  const f = caughtFailure(Date.now(), undici);
  assert.ok(!f.error!.includes(KEY) && f.error!.includes("[redacted]"));
  assert.ok(!errorForLog(undici).includes(KEY));
  assert.ok(!redact(`connect to postgres://user:pw@host/db failed`).includes("pw@"));
  assert.ok(!redact(`Incorrect API key provided: ${KEY}`).includes(KEY));
});
