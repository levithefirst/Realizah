import { redact } from "../redact";

// Provider adapters. A provider is an access path to models; it is not a
// model. Adapters never see prices: cost is computed from the registry's
// price snapshot so every provider is priced the same way.

export type ChatMessage = { role: "system" | "user"; content: string };

export type RunModelRequest = {
  externalModelId: string;
  messages: ChatMessage[];
  maxTokens: number;
  timeoutMs: number;
  // Only sent when the model's catalog entry lists it; otherwise provider default.
  temperature?: number;
};

export type RunModelResult = {
  ok: boolean;
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  latencyMs: number;
  finishReason: string | null;
  // Some providers report what they billed; kept for reconciliation only.
  providerReportedCostUsd: number | null;
  error: string | null;
  errorKind: "timeout" | "not_found" | "rate_limited" | "auth" | "provider_error" | "network" | "unsupported_endpoint" | null;
  // HTTP status of a failed provider response, when there was one.
  httpStatus?: number | null;
};

// Result of a cheap, non-billable authentication probe (e.g. GET /key).
// "unreachable" means the probe could not tell; it never blocks a run.
export type AuthCheck = { state: "ok" | "auth_failed" | "unreachable"; detail: string | null };

export interface ProviderAdapter {
  id: string;
  // True only when a usable credential is present (see credentials.ts).
  isConfigured(): boolean;
  // Why the provider is not configured, without the key itself.
  configIssue?(): string | null;
  checkAuth?(): Promise<AuthCheck>;
  run(req: RunModelRequest): Promise<RunModelResult>;
}

// Probes an authenticated, non-billable endpoint. 401/403 means the key is
// rejected; anything else that isn't 2xx is inconclusive.
export async function probeAuth(url: string, headers: Record<string, string>, fetchImpl: typeof fetch, timeoutMs = 5_000): Promise<AuthCheck> {
  try {
    const res = await fetchImpl(url, { method: "GET", headers, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
    if (res.ok) return { state: "ok", detail: null };
    const json = (await res.json().catch(() => null)) as any;
    const message = redact(String(json?.error?.message ?? `HTTP ${res.status}`)).slice(0, 200);
    if (res.status === 401 || res.status === 403) return { state: "auth_failed", detail: message };
    return { state: "unreachable", detail: message };
  } catch (e) {
    return { state: "unreachable", detail: ((e as Error)?.name === "TimeoutError" ? "auth check timed out" : "auth check failed to connect") };
  }
}

// Provider messages that mean "this id exists but not on chat completions".
// Also covers retired ids: the provider still lists them but won't serve them.
const UNSUPPORTED_ENDPOINT = /not a chat model|not supported in the v1\/chat\/completions|only supported in v1\/responses|use the (?:v1\/)?(?:responses|completions) (?:api|endpoint)|does not support chat|has been deprecated|has been retired|is no longer (?:available|supported)/i;

export function errorKindFromResponse(status: number, message: string): RunModelResult["errorKind"] {
  if (UNSUPPORTED_ENDPOINT.test(message)) return "unsupported_endpoint";
  return errorKindFromStatus(status);
}

export function errorKindFromStatus(status: number): RunModelResult["errorKind"] {
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth";
  return "provider_error";
}

export function failure(started: number, error: string, errorKind: RunModelResult["errorKind"], httpStatus: number | null = null): RunModelResult {
  return {
    ok: false,
    text: "",
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    latencyMs: Date.now() - started,
    finishReason: null,
    providerReportedCostUsd: null,
    // Stored and shown to the user: never let a key through.
    error: redact(error),
    errorKind,
    httpStatus,
  };
}

export function caughtFailure(started: number, e: unknown): RunModelResult {
  const err = e as Error;
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return failure(started, "timed out", "timeout");
  return failure(started, (err?.message ?? "network error").slice(0, 300), "network");
}
