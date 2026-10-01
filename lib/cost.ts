export function estimateCostUsd(
  tokensIn: number,
  tokensOut: number,
  inputUsdPer1m: number | null,
  outputUsdPer1m: number | null
): number | null {
  if (inputUsdPer1m === null || outputUsdPer1m === null) return null;
  return (tokensIn * inputUsdPer1m + tokensOut * outputUsdPer1m) / 1_000_000;
}

export function formatUsd(v: number | null | undefined): string {
  if (v === null || v === undefined) return "UNKNOWN";
  if (v === 0) return "$0";
  if (v < 0.01) return "$" + v.toFixed(6);
  return "$" + v.toFixed(2);
}
