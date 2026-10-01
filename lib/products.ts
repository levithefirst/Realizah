// AI products: what the user says they use. A product is not a model, and a
// product's per-task cost is unknown unless verified and stored as such.
import type { ProductCapability } from "./task/understand";

export type AiProduct = {
  slug: string;
  name: string;
  aliases: string[];
  capability: ProductCapability;
  baselineStatus: "verified" | "estimated" | "unknown";
  baselineMethodology: string | null;
  baselineSourceUrl: string | null;
  // Only set with a stored, sourced mapping. Never inferred.
  verifiedModelId: string | null;
};

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function matchProduct(input: string, products: AiProduct[]): AiProduct | null {
  const q = norm(input);
  if (!q) return null;
  let best: AiProduct | null = null;
  let bestLen = 0;
  for (const p of products) {
    for (const key of [p.name, p.slug, ...p.aliases].map(norm)) {
      if (key && (q === key || q.startsWith(key + " ")) && key.length > bestLen) {
        best = p;
        bestLen = key.length;
      }
    }
  }
  return best;
}

export function searchProducts(query: string, products: AiProduct[]): AiProduct[] {
  const q = norm(query);
  if (!q) return products;
  return products
    .map((p) => {
      const keys = [p.name, ...p.aliases].map(norm);
      const rank = keys.some((k) => k.startsWith(q)) ? 0 : keys.some((k) => k.includes(q)) ? 1 : 2;
      return { p, rank };
    })
    .filter((x) => x.rank < 2)
    .sort((a, b) => a.rank - b.rank || a.p.name.localeCompare(b.p.name))
    .map((x) => x.p);
}

export type Baseline = {
  product: string;
  productSlug: string | null;
  status: "verified" | "estimated" | "unknown";
  methodology: string | null;
  source: string | null;
  taskRun: boolean;
  taskCostKnown: boolean;
  costUsd: number | null;
  message: string;
};

// The current tool's cost for this task. Known only when the product has a
// verified model mapping AND that model ran in this comparison with a price.
export function currentToolBaseline(opts: {
  input: string;
  product: AiProduct | null;
  verifiedModelResult?: { costUsd: number | null } | null;
}): Baseline {
  const name = opts.product?.name ?? (opts.input.trim() || "Your tool");
  const p = opts.product;
  if (p && p.verifiedModelId && p.baselineStatus !== "unknown" && opts.verifiedModelResult) {
    const cost = opts.verifiedModelResult.costUsd;
    return {
      product: name,
      productSlug: p.slug,
      status: p.baselineStatus,
      methodology: p.baselineMethodology,
      source: p.baselineSourceUrl,
      taskRun: true,
      taskCostKnown: cost !== null,
      costUsd: cost,
      message:
        cost !== null
          ? `${name}'s task cost is ${p.baselineStatus} through its stored model mapping.`
          : `${name} has a ${p.baselineStatus} model mapping, but this run's cost is unknown.`,
    };
  }
  return {
    product: name,
    productSlug: p?.slug ?? null,
    status: "unknown",
    methodology: p?.baselineMethodology ?? null,
    source: p?.baselineSourceUrl ?? null,
    taskRun: false,
    taskCostKnown: false,
    costUsd: null,
    message: `Current tool cost unavailable. ${name} is a product, not a single model, and Realizah has no verified per-task cost for it. The labels below compare the models Realizah tested, not ${name}.`,
  };
}
