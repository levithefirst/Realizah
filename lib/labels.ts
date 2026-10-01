import { formatUsd } from "./cost";

export type Labelable = {
  slug: string;
  label: string;
  passed: boolean | null;
  estimatedCostUsd: number | null;
  costPerSuccessUsd: number | null;
  cheaperCost: boolean;
  betterCost: boolean;
};

function lowest(cards: Labelable[], value: (r: Labelable) => number | null): Labelable[] {
  const priced = cards.filter((r) => value(r) !== null);
  if (priced.length === 0) return [];
  const min = Math.min(...priced.map((r) => value(r)!));
  return priced.filter((r) => value(r) === min);
}

function names(cards: Labelable[]): string {
  return cards.map((r) => r.label).join(" and ");
}

// Two independent labels. A model can carry one, both, or neither.
// Ties share the label. Nothing here ranks answer quality.
export function assignLabels(cards: Labelable[]): { cheaper: string[]; better: string[]; summary: string } {
  const cheaper = lowest(cards, (r) => r.estimatedCostUsd);
  const better = lowest(
    cards.filter((r) => r.passed),
    (r) => r.costPerSuccessUsd
  );
  for (const c of cards) {
    c.cheaperCost = cheaper.includes(c);
    c.betterCost = better.includes(c);
  }

  const parts: string[] = [];
  parts.push(
    cheaper.length
      ? `Cheaper cost: ${names(cheaper)} at ${formatUsd(cheaper[0].estimatedCostUsd)} for this run.`
      : "Cheaper cost: none, no call finished with a known price."
  );
  if (better.length) {
    parts.push(`Better cost: ${names(better)} at ${formatUsd(better[0].costPerSuccessUsd)} per successful outcome.`);
  } else if (cards.some((r) => r.passed)) {
    parts.push("Better cost: none, the passing models have UNKNOWN prices.");
  } else {
    parts.push("Better cost: none, no model passed.");
  }
  return {
    cheaper: cheaper.map((r) => r.slug),
    better: better.map((r) => r.slug),
    summary: parts.join(" "),
  };
}
