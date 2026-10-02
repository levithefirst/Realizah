import { describeIssue, readCredential } from "./credentials";
import { chatCompletions } from "./openaiCompatible";
import { probeAuth, type ProviderAdapter, type RunModelRequest } from "./types";

export function openRouterAdapter(opts: { apiKey?: string; appUrl?: string; fetchImpl?: typeof fetch } = {}): ProviderAdapter {
  const cred = () => readCredential(opts.apiKey ?? process.env.OPENROUTER_API_KEY);
  const auth = () => ({ authorization: `Bearer ${cred().key}` });
  return {
    id: "openrouter",
    isConfigured: () => cred().key !== null,
    configIssue: () => {
      const c = cred();
      return c.issue ? describeIssue("OPENROUTER_API_KEY", c.issue) : null;
    },
    // GET /key describes the calling key and costs nothing.
    checkAuth: () => probeAuth("https://openrouter.ai/api/v1/key", auth(), opts.fetchImpl ?? fetch),
    run: (req: RunModelRequest) =>
      chatCompletions({
        url: "https://openrouter.ai/api/v1/chat/completions",
        headers: {
          ...auth(),
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
