// Picks the models a comparison runs on. Server-side only in practice, but
// pure so it can be tested: no env reads, no database.
import type { Tool } from "./tools";

// Safety cap on calls per run. Raise with MAX_MODELS_PER_RUN as the pool grows.
export const DEFAULT_MAX_MODELS = 10;
export const MIN_MODELS = 2;

export function selectModels(
  pool: Tool[],
  opts: {
    // Providers we hold a key for, e.g. new Set(["openai"]).
    providers: ReadonlySet<string>;
    max?: number;
    // A verified mapping for the user's tool always gets a card.
    verifiedModelSlug?: string | null;
  }
): Tool[] {
  const max = opts.max && opts.max > 0 ? Math.floor(opts.max) : DEFAULT_MAX_MODELS;
  const runnable = (t: Tool) => opts.providers.has(t.provider);
  const chosen = pool
    .filter((t) => t.enabled && runnable(t))
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .slice(0, max);
  const verified = opts.verifiedModelSlug ? pool.find((t) => t.slug === opts.verifiedModelSlug) : undefined;
  if (verified && runnable(verified) && !chosen.some((t) => t.slug === verified.slug)) {
    chosen[chosen.length === max ? max - 1 : chosen.length] = verified;
  }
  return chosen;
}

export function comparedAcross(n: number): string {
  return `Compared across ${n} ${n === 1 ? "model" : "models"}`;
}
