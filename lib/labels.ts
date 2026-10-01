// The only two labels.
// Cheaper cost: lowest estimated dollars for this run (pass or fail).
// Better cost:  lowest dollars per successful outcome. A fail never gets it;
//               if nothing passes, it does not exist.
// Ties share a label. Nothing here ranks answer quality.

export type Labelable = {
  key: string;
  label: string;
  passed: boolean;
  estimatedCostUsd: number | null;
  costPerSuccessUsd: number | null;
};

function lowest<T extends Labelable>(xs: T[], value: (x: T) => number | null): T[] {
  const priced = xs.filter((x) => value(x) !== null);
  if (!priced.length) return [];
  const min = Math.min(...priced.map((x) => value(x)!));
  return priced.filter((x) => value(x) === min);
}

export function assignLabels<T extends Labelable>(xs: T[]): { cheaper: string[]; better: string[] } {
  return {
    cheaper: lowest(xs, (x) => x.estimatedCostUsd).map((x) => x.key),
    better: lowest(xs.filter((x) => x.passed), (x) => x.costPerSuccessUsd).map((x) => x.key),
  };
}
