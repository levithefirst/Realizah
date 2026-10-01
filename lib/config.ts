// Server-side safety limits. Every comparison is bounded by these.
function num(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

export type ExecutionLimits = {
  maxCandidates: number;
  maxExecutionCostUsd: number;
  maxOutputTokens: number;
  timeoutMs: number;
  maxConcurrent: number;
  reasoningHeadroomTokens: number;
};

export function executionLimits(): ExecutionLimits {
  return {
    maxCandidates: Math.floor(num("MAX_CANDIDATES_PER_RUN", 20, 1, 50)),
    maxExecutionCostUsd: num("MAX_EXECUTION_COST_USD", 0.1, 0.001, 10),
    maxOutputTokens: Math.floor(num("MAX_OUTPUT_TOKENS", 4096, 64, 32_000)),
    timeoutMs: Math.floor(num("TIMEOUT_MS", 60_000, 5_000, 280_000)),
    maxConcurrent: Math.floor(num("MAX_CONCURRENT_MODELS", 8, 1, 25)),
    reasoningHeadroomTokens: Math.floor(num("REASONING_HEADROOM_TOKENS", 2048, 0, 16_000)),
  };
}
