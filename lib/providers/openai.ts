import { describeIssue, readCredential } from "./credentials";
import { chatCompletions } from "./openaiCompatible";
import { probeAuth, type ProviderAdapter, type RunModelRequest } from "./types";

export function openAIAdapter(opts: { apiKey?: string; fetchImpl?: typeof fetch } = {}): ProviderAdapter {
  const cred = () => readCredential(opts.apiKey ?? process.env.OPENAI_API_KEY);
  const auth = () => ({ authorization: `Bearer ${cred().key}` });
  return {
    id: "openai",
    isConfigured: () => cred().key !== null,
    configIssue: () => {
      const c = cred();
      return c.issue ? describeIssue("OPENAI_API_KEY", c.issue) : null;
    },
    // Listing models authenticates the key and is not billed.
    checkAuth: () => probeAuth("https://api.openai.com/v1/models", auth(), opts.fetchImpl ?? fetch),
    run: (req: RunModelRequest) =>
      chatCompletions({
        url: "https://api.openai.com/v1/chat/completions",
        headers: auth(),
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
