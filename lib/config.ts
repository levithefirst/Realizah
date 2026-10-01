// Server-side safety limits. Every comparison is bounded by these.
// All are environment variables; the values here are only defaults.
function num(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

export type ExecutionLimits = {
  // Most paid models executed in one comparison.
  maxCandidates: number;
  // Paid models a comparison runs before it may stop early.
  minCandidates: number;
  // Hard cap on Realizah's own model spend per comparison. 0 = no paid calls.
  maxExecutionCostUsd: number;
  // A single model whose worst case exceeds this is dropped before any call.
  maxCostPerCandidateUsd: number;
  // Global ceiling on output tokens; each task gets its own lower ceiling.
  maxOutputTokens: number;
  timeoutMs: number;
  maxConcurrent: number;
  reasoningHeadroomTokens: number;
  // Free-tier screening runs (shown, never labeled). 0 disables screening.
  freeScreeningModels: number;
};

export function executionLimits(): ExecutionLimits {
  const maxExecutionCostUsd = num("MAX_EXECUTION_COST_USD", 0.03, 0, 10);
  const maxCandidates = Math.floor(num("MAX_CANDIDATES_PER_RUN", 10, 1, 50));
  return {
    maxCandidates,
    minCandidates: Math.min(maxCandidates, Math.floor(num("MIN_CANDIDATES_PER_RUN", 4, 1, 50))),
    maxExecutionCostUsd,
    maxCostPerCandidateUsd: num("MAX_COST_PER_CANDIDATE_USD", maxExecutionCostUsd / 3, 0, 10),
    maxOutputTokens: Math.floor(num("MAX_OUTPUT_TOKENS", 4096, 64, 32_000)),
    timeoutMs: Math.floor(num("TIMEOUT_MS", 60_000, 5_000, 280_000)),
    maxConcurrent: Math.floor(num("MAX_CONCURRENT_MODELS", 5, 1, 25)),
    reasoningHeadroomTokens: Math.floor(num("REASONING_HEADROOM_TOKENS", 1024, 0, 16_000)),
    freeScreeningModels: Math.floor(num("FREE_SCREENING_MODELS", 2, 0, 5)),
  };
}
