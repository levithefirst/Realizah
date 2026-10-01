// Direct OpenAI access paths. Discovery: OpenAI's own /v1/models for our key.
// A direct id is linked to a registry model only by exact catalog id
// ("openai/<id>"); nothing is inferred from names.
import type { NormalizedAccess, NormalizedPrice } from "../types";

const SOURCE = "openai_models_api";

export type VerifiedPrice = { modelId: string; input: number; output: number; sourceUrl: string };

export async function fetchOpenAIModelIds(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const res = await fetchImpl("https://api.openai.com/v1/models", {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`OpenAI /v1/models HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { id?: string }[] };
  return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
}

export function linkOpenAIDirect(opts: {
  directIds: string[];
  registrySlugs: Set<string>;
  // Prices OpenAI publishes, verified by hand (legacy tools_seed rows).
  verifiedPrices: VerifiedPrice[];
  // OpenRouter's price for the same model, used as a documented estimate.
  openrouterPrices: Map<string, { input: number | null; output: number | null }>;
}): { access: NormalizedAccess[]; prices: NormalizedPrice[] } {
  const access: NormalizedAccess[] = [];
  const prices: NormalizedPrice[] = [];
  const verified = new Map(opts.verifiedPrices.map((p) => [p.modelId, p]));
  for (const id of opts.directIds) {
    const slug = `openai/${id}`;
    if (!opts.registrySlugs.has(slug)) continue;
    access.push({ modelSlug: slug, providerId: "openai", externalModelId: id, source: SOURCE });
    const v = verified.get(id);
    const or = opts.openrouterPrices.get(slug);
    if (v) {
      prices.push({
        providerId: "openai",
        externalModelId: id,
        inputUsdPer1m: v.input,
        outputUsdPer1m: v.output,
        requestUsd: 0,
        status: "verified",
        methodology: "OpenAI's published price for this model, checked by hand.",
        source: "openai_pricing_page",
        sourceUrl: v.sourceUrl,
      });
    } else if (or && or.input !== null && or.output !== null) {
      prices.push({
        providerId: "openai",
        externalModelId: id,
        inputUsdPer1m: or.input,
        outputUsdPer1m: or.output,
        requestUsd: 0,
        status: "estimated",
        methodology:
          "OpenRouter's catalog price for the same OpenAI model. OpenRouter passes provider pricing through, but this was not checked against OpenAI's own price page.",
        source: "openrouter_catalog",
        sourceUrl: "https://openrouter.ai/api/v1/models",
      });
    } else {
      prices.push({
        providerId: "openai",
        externalModelId: id,
        inputUsdPer1m: null,
        outputUsdPer1m: null,
        requestUsd: 0,
        status: "unknown",
        methodology: "No verified or documented price for this direct OpenAI id.",
        source: SOURCE,
        sourceUrl: null,
      });
    }
  }
  return { access, prices };
}
