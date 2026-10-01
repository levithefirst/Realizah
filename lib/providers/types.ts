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
};

export interface ProviderAdapter {
  id: string;
  isConfigured(): boolean;
  run(req: RunModelRequest): Promise<RunModelResult>;
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

export function failure(started: number, error: string, errorKind: RunModelResult["errorKind"]): RunModelResult {
  return {
    ok: false,
    text: "",
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    latencyMs: Date.now() - started,
    finishReason: null,
    providerReportedCostUsd: null,
    error,
    errorKind,
  };
}

export function caughtFailure(started: number, e: unknown): RunModelResult {
  const err = e as Error;
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return failure(started, "timed out", "timeout");
  return failure(started, (err?.message ?? "network error").slice(0, 300), "network");
}
