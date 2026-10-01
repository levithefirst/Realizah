// Server-only OpenAI chat completions client. The key never leaves the server.
import "server-only";
import { ModelNotFoundError, type ChatFn } from "./engine";

export const MAX_OUTPUT_TOKENS = 400;
export const TIMEOUT_MS = 25_000;

export const chat: ChatFn = async function chat(opts) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set on the server");

  const started = Date.now();
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: opts.model,
      temperature: opts.temperature,
      max_completion_tokens: MAX_OUTPUT_TOKENS,
      messages: opts.messages,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  const latencyMs = Date.now() - started;

  const body = (await res.json().catch(() => null)) as any;
  if (!res.ok) {
    const code = body?.error?.code;
    const message = body?.error?.message ?? `HTTP ${res.status}`;
    if (res.status === 404 || code === "model_not_found") {
      throw new ModelNotFoundError(message);
    }
    throw new Error(`OpenAI ${res.status}: ${String(message).slice(0, 200)}`);
  }

  return {
    text: String(body?.choices?.[0]?.message?.content ?? ""),
    tokensIn: Number(body?.usage?.prompt_tokens ?? 0),
    tokensOut: Number(body?.usage?.completion_tokens ?? 0),
    latencyMs,
  };
};
