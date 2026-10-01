// Task-level cost from per-1M-token prices. $0.15 per 1M tokens is
// $0.00000015 per token, never $0.15 per request.

export type PriceSnapshot = {
  inputUsdPer1m: number | null;
  outputUsdPer1m: number | null;
  requestUsd?: number;
};

export function taskCostUsd(inputTokens: number | null, outputTokens: number | null, p: PriceSnapshot): number | null {
  if (inputTokens === null || outputTokens === null) return null;
  if (p.inputUsdPer1m === null || p.outputUsdPer1m === null) return null;
  return (inputTokens * p.inputUsdPer1m + outputTokens * p.outputUsdPer1m) / 1_000_000 + (p.requestUsd ?? 0);
}

// Upper bound before running: every allowed output token is spent.
export function worstCaseCostUsd(inputTokens: number, maxOutputTokens: number, p: PriceSnapshot): number | null {
  return taskCostUsd(inputTokens, maxOutputTokens, p);
}

export function formatUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "UNKNOWN";
  if (v === 0) return "$0";
  if (v < 0.01) return "$" + v.toPrecision(2).replace(/(\.\d*?[1-9])0+$/, "$1");
  return "$" + v.toFixed(2);
}
