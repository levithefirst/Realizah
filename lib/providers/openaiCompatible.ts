// Shared chat-completions call for OpenAI-compatible APIs (OpenRouter, OpenAI).
import { caughtFailure, errorKindFromResponse, failure, type RunModelRequest, type RunModelResult } from "./types";

export async function chatCompletions(opts: {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  req: RunModelRequest;
  fetchImpl: typeof fetch;
}): Promise<RunModelResult> {
  const started = Date.now();
  try {
    const res = await opts.fetchImpl(opts.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...opts.headers },
      body: JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.req.timeoutMs),
      cache: "no-store",
    });
    const json = (await res.json().catch(() => null)) as any;
    if (!res.ok) {
      const message = json?.error?.message ?? `HTTP ${res.status}`;
      return failure(started, String(message).slice(0, 300), errorKindFromResponse(res.status, String(message)), res.status);
    }
    if (json?.error) {
      return failure(started, String(json.error.message ?? "provider error").slice(0, 300), "provider_error");
    }
    const choice = json?.choices?.[0];
    const usage = json?.usage ?? {};
    const inputTokens = Number.isFinite(usage.prompt_tokens) ? Number(usage.prompt_tokens) : null;
    const outputTokens = Number.isFinite(usage.completion_tokens) ? Number(usage.completion_tokens) : null;
    const cost = Number(usage.cost);
    return {
      ok: true,
      text: typeof choice?.message?.content === "string" ? choice.message.content : "",
      inputTokens,
      outputTokens,
      totalTokens: Number.isFinite(usage.total_tokens)
        ? Number(usage.total_tokens)
        : inputTokens !== null && outputTokens !== null
          ? inputTokens + outputTokens
          : null,
      latencyMs: Date.now() - started,
      finishReason: choice?.finish_reason ?? null,
      providerReportedCostUsd: Number.isFinite(cost) ? cost : null,
      error: null,
      errorKind: null,
    };
  } catch (e) {
    return caughtFailure(started, e);
  }
}
