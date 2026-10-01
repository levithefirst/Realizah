import { chatCompletions } from "./openaiCompatible";
import type { ProviderAdapter, RunModelRequest } from "./types";

export function openAIAdapter(opts: { apiKey?: string; fetchImpl?: typeof fetch } = {}): ProviderAdapter {
  const key = () => opts.apiKey ?? process.env.OPENAI_API_KEY;
  return {
    id: "openai",
    isConfigured: () => Boolean(key()),
    run: (req: RunModelRequest) =>
      chatCompletions({
        url: "https://api.openai.com/v1/chat/completions",
        headers: { authorization: `Bearer ${key()}` },
        body: {
          model: req.externalModelId,
          messages: req.messages,
          max_completion_tokens: req.maxTokens,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        },
        req,
        fetchImpl: opts.fetchImpl ?? fetch,
      }),
  };
}
