// P0/P2: provider readiness reflects whether a provider can authenticate,
// with a cached probe (never one per plan request).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { providerReadiness, recordAuthFailure, resetProviderHealth } from "../lib/providers/readiness";
import type { AuthCheck, ProviderAdapter } from "../lib/providers/types";

function fake(id: string, opts: { configured?: boolean; check?: AuthCheck | (() => Promise<AuthCheck>) } = {}) {
  let probes = 0;
  const a: ProviderAdapter = {
    id,
    isConfigured: () => opts.configured ?? true,
    configIssue: () => (opts.configured === false ? `${id.toUpperCase()}_API_KEY is set but empty or whitespace.` : null),
    credentialShape: () => 'starts with "sk-or-v1-", 73 characters',
    checkAuth: async () => {
      probes++;
      const c = opts.check ?? { state: "ok", detail: null };
      return typeof c === "function" ? c() : c;
    },
    run: async () => {
      throw new Error("not used");
    },
  };
  return { a, probes: () => probes };
}

beforeEach(() => resetProviderHealth());

test("readiness: unconfigured providers are reported with the reason, not the key", async () => {
  const { a } = fake("openrouter", { configured: false });
  const r = await providerReadiness({ verify: true, adapters: [a] });
  assert.equal(r.ready.size, 0);
  assert.deepEqual(r.statuses[0], { provider: "openrouter", state: "not_configured", detail: "OPENROUTER_API_KEY is set but empty or whitespace.", checkedAt: null });
});

test("readiness: a provider that rejects its key is not ready; the others still are", async () => {
  const or = fake("openrouter", { check: { state: "auth_failed", detail: "Missing Authentication header" } });
  const oa = fake("openai");
  const r = await providerReadiness({ verify: true, adapters: [or.a, oa.a] });
  assert.deepEqual([...r.ready.keys()], ["openai"]);
  assert.equal(r.statuses[0].state, "auth_failed");
  assert.match(r.statuses[0].detail!, /Missing Authentication header/);
  assert.match(r.statuses[0].detail!, /Key starts with "sk-or-v1-", 73 characters\./);
  assert.equal(r.statuses[1].state, "ready");
});

test("readiness: the probe is cached and shared by concurrent callers", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const or = fake("openrouter", { check: async () => (await gate, { state: "ok", detail: null }) });
  const pending = Promise.all([1, 2, 3].map(() => providerReadiness({ verify: true, adapters: [or.a] })));
  release();
  await pending;
  await providerReadiness({ verify: true, adapters: [or.a] });
  assert.equal(or.probes(), 1, "one probe for four calls");
});

test("readiness: plan-time checks never probe, but honour known failures", async () => {
  const or = fake("openrouter");
  const plan = await providerReadiness({ verify: false, adapters: [or.a] });
  assert.equal(or.probes(), 0);
  assert.equal(plan.statuses[0].state, "unverified");
  assert.ok(plan.ready.has("openrouter"));
  recordAuthFailure("openrouter", "Missing Authentication header");
  const after = await providerReadiness({ verify: false, adapters: [or.a] });
  assert.equal(after.ready.size, 0);
  assert.equal(after.statuses[0].state, "auth_failed");
});

test("readiness: an inconclusive probe (provider down) does not block, and expires quickly", async () => {
  const or = fake("openrouter", { check: { state: "unreachable", detail: "auth check timed out" } });
  const t0 = 1_000_000;
  const r = await providerReadiness({ verify: true, adapters: [or.a], now: t0 });
  assert.ok(r.ready.has("openrouter"));
  assert.equal(r.statuses[0].state, "unverified");
  await providerReadiness({ verify: true, adapters: [or.a], now: t0 + 30_000 });
  assert.equal(or.probes(), 1);
  await providerReadiness({ verify: true, adapters: [or.a], now: t0 + 61_000 });
  assert.equal(or.probes(), 2);
});
