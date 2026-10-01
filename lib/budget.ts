// The user's budget is hypothetical: "what would $X buy at these prices?"
// It is never spent. Realizah's own execution spend is a separate limit.

export type BudgetLine = {
  budgetUsd: number;
  exceedsBudget: boolean;
  successfulRunsWithinBudget: number | null; // null when the result failed or cost is unknown
  isEstimate: true;
};

export function budgetLine(budgetUsd: number, r: { estimatedCostUsd: number | null; costPerSuccessUsd: number | null }): BudgetLine {
  const cps = r.costPerSuccessUsd;
  return {
    budgetUsd,
    exceedsBudget: r.estimatedCostUsd !== null && r.estimatedCostUsd > budgetUsd,
    successfulRunsWithinBudget: cps !== null && cps > 0 ? Math.floor(budgetUsd / cps) : null,
    isEstimate: true,
  };
}

export function parseBudget(v: unknown): number | null | "invalid" {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v).trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,4})?$/.test(s)) return "invalid";
  const n = Number(s);
  return n > 0 && n <= 1_000_000 ? n : "invalid";
}
