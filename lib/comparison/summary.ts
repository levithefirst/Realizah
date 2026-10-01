import { formatUsd } from "../pricing";
import type { Baseline } from "../products";

// The headline sentence. It speaks about the tested models only; the
// current tool is mentioned only when its task cost is actually known.
export function comparisonSummary(opts: {
  attempted: number;
  cheaper: { names: string[]; costUsd: number | null };
  better: { names: string[]; costPerSuccessUsd: number | null };
  baseline: Baseline;
}): string {
  let s = opts.cheaper.names.length
    ? `Cheaper cost among the ${opts.attempted} tested models: ${opts.cheaper.names.join(" and ")} at ${formatUsd(opts.cheaper.costUsd)} for this run.`
    : "Cheaper cost: none, no call finished with a known price.";
  s +=
    " " +
    (opts.better.names.length
      ? `Better cost: ${opts.better.names.join(" and ")} at ${formatUsd(opts.better.costPerSuccessUsd)} per successful outcome.`
      : "Better cost: none, no model passed this task.");
  if (opts.baseline.taskCostKnown && opts.baseline.costUsd !== null) {
    s += ` ${opts.baseline.product} (${opts.baseline.status} baseline): ${formatUsd(opts.baseline.costUsd)} for this task.`;
  }
  return s;
}
