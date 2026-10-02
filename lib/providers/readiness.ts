// Which providers can actually execute right now. Configured (a usable key)
// is necessary but not sufficient: a key can be present and still rejected.
// Readiness combines the static credential check with a cheap, cached auth
// probe and with auth failures observed during real runs.
//
// Callers that pass verify: true probe at most once per TTL per server
// instance, and concurrent callers share one probe; verify: false only
// honours what is already known (no network at all).
import { defaultAdapters } from "./index";
import type { AuthCheck, ProviderAdapter } from "./types";

export type ProviderState = "ready" | "unverified" | "not_configured" | "auth_failed";
export type ProviderStatus = { provider: string; state: ProviderState; detail: string | null; checkedAt: string | null };

const TTL_MS: Record<AuthCheck["state"], number> = {
  ok: 10 * 60_000,
  auth_failed: 5 * 60_000,
  unreachable: 60_000,
};

type Entry = { check: AuthCheck; at: number };
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<AuthCheck>>();

export function resetProviderHealth() {
  cache.clear();
  inflight.clear();
}

// A real call was rejected for authentication: stop routing to the provider
// until the TTL lapses (or the deployment, and so the key, changes).
export function recordAuthFailure(providerId: string, detail: string | null, now = Date.now()) {
  cache.set(providerId, { check: { state: "auth_failed", detail }, at: now });
}

function cached(id: string, now: number): Entry | null {
  const e = cache.get(id);
  return e && now - e.at < TTL_MS[e.check.state] ? e : null;
}

async function probe(a: ProviderAdapter, now: number): Promise<Entry> {
  let p = inflight.get(a.id);
  if (!p) {
    p = a.checkAuth!().finally(() => inflight.delete(a.id));
    inflight.set(a.id, p);
  }
  const entry = { check: await p, at: now };
  cache.set(a.id, entry);
  return entry;
}

export async function providerReadiness(
  opts: { verify: boolean; adapters?: ProviderAdapter[]; now?: number }
): Promise<{ ready: Map<string, ProviderAdapter>; statuses: ProviderStatus[] }> {
  const now = opts.now ?? Date.now();
  const adapters = opts.adapters ?? defaultAdapters();
  const ok = new Set<string>();
  const statuses = await Promise.all(
    adapters.map(async (a): Promise<ProviderStatus> => {
      if (!a.isConfigured()) return { provider: a.id, state: "not_configured", detail: a.configIssue?.() ?? "No usable API key.", checkedAt: null };
      let e = cached(a.id, now);
      if (!e && opts.verify && a.checkAuth) e = await probe(a, now);
      const checkedAt = e ? new Date(e.at).toISOString() : null;
      if (e?.check.state === "auth_failed") {
        const shape = a.credentialShape?.();
        const detail = `The provider rejected the API key${e.check.detail ? `: ${e.check.detail}` : ""}.${shape ? ` Key ${shape}.` : ""}`;
        return { provider: a.id, state: "auth_failed", detail, checkedAt };
      }
      ok.add(a.id);
      return e?.check.state === "ok"
        ? { provider: a.id, state: "ready", detail: null, checkedAt }
        : { provider: a.id, state: "unverified", detail: e?.check.detail ?? null, checkedAt };
    })
  );
  return { ready: new Map(adapters.filter((a) => ok.has(a.id)).map((a) => [a.id, a])), statuses };
}
