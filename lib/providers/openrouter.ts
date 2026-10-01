import { chatCompletions } from "./openaiCompatible";
import type { ProviderAdapter, RunModelRequest } from "./types";

export function openRouterAdapter(opts: { apiKey?: string; appUrl?: string; fetchImpl?: typeof fetch } = {}): ProviderAdapter {
  const key = () => opts.apiKey ?? process.env.OPENROUTER_API_KEY;
  return {
    id: "openrouter",
    isConfigured: () => Boolean(key()),
    run: (req: RunModelRequest) =>
      chatCompletions({
        url: "https://openrouter.ai/api/v1/chat/completions",
        headers: {
          authorization: `Bearer ${key()}`,
          "HTTP-Referer": opts.appUrl ?? process.env.APP_URL ?? "https://realizah.vercel.app",
          "X-Title": "Realizah",
        },
        body: {
          model: req.externalModelId,
          messages: req.messages,
          max_tokens: req.maxTokens,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          // Ask OpenRouter to report what it billed, for reconciliation.
          usage: { include: true },
        },
        req,
        fetchImpl: opts.fetchImpl ?? fetch,
      }),
  };
}
