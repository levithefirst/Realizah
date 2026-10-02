// Strips anything that looks like a credential from text that may be stored,
// logged or shown: provider error messages can echo a key (OpenAI's
// "Incorrect API key provided: sk-...", undici's "invalid header value").
const PATTERNS: [RegExp, string][] = [
  [/\bBearer\s+[^\s"',]+/gi, "Bearer [redacted]"],
  [/\bsk-[A-Za-z0-9_*-]{6,}/g, "[redacted key]"],
  [/\b(?:api[_-]?key|token|secret|password)=\S+/gi, "[redacted]"],
  [/postgres(?:ql)?:\/\/[^\s"']+/gi, "postgres://[redacted]"],
];

export function redact(text: string): string {
  return PATTERNS.reduce((t, [re, sub]) => t.replace(re, sub), text);
}

// For logs: the error's message only (no request objects, no headers).
export function errorForLog(e: unknown): string {
  return redact(e instanceof Error ? `${e.name}: ${e.message}` : "unknown error");
}
