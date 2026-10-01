// OpenRouter model catalog: discovery + prices for the OpenRouter access path.
// Public endpoint; no key needed to read it.
import type { NormalizedAccess, NormalizedModel, NormalizedPrice } from "../types";

export const OPENROUTER_CATALOG_URL = "https://openrouter.ai/api/v1/models";
const SOURCE = "openrouter_catalog";

export type OpenRouterCatalogModel = {
  id: string;
  canonical_slug?: string;
  name?: string;
  description?: string;
  created?: number;
  context_length?: number | null;
  architecture?: { input_modalities?: string[]; output_modalities?: string[]; modality?: string };
  pricing?: Record<string, string | number | undefined>;
  top_provider?: { context_length?: number | null; max_completion_tokens?: number | null };
  supported_parameters?: string[];
  knowledge_cutoff?: string | null;
  expiration_date?: string | null;
};

// "0.00000015" per token -> 0.15 per 1M. Negative or non-numeric means the
// price is variable or missing: unknown, never zero.
export function perTokenToPer1m(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1e6 * 1e6) / 1e6;
}

function isoDate(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return new Date(v * 1000).toISOString().slice(0, 10);
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  return null;
}

// Free variants ("x/y:free") are an access path of the same model, not a new model.
export function baseSlug(id: string): string {
  return id.endsWith(":free") ? id.slice(0, -":free".length) : id;
}

export function isFreeVariant(externalModelId: string): boolean {
  return externalModelId.endsWith(":free");
}

// Routers such as "openrouter/auto" pick a model per request: not a model.
export function isRouter(id: string): boolean {
  return id.startsWith("openrouter/");
}

export function normalizeOpenRouterCatalog(rows: OpenRouterCatalogModel[]): {
  models: NormalizedModel[];
  access: NormalizedAccess[];
  prices: NormalizedPrice[];
  skipped: { id: string; reason: string }[];
} {
  const models = new Map<string, NormalizedModel>();
  const access: NormalizedAccess[] = [];
  const prices: NormalizedPrice[] = [];
  const skipped: { id: string; reason: string }[] = [];

  for (const r of rows) {
    if (!r || typeof r.id !== "string" || !r.id.includes("/")) {
      skipped.push({ id: String(r?.id), reason: "malformed id" });
      continue;
    }
    if (isRouter(r.id)) {
      skipped.push({ id: r.id, reason: "router, not a model" });
      continue;
    }
    const slug = baseSlug(r.id);
    const free = isFreeVariant(r.id);
    const existing = models.get(slug);
    // Prefer the paid entry's metadata when both paid and free are listed.
    if (!existing || (!free && existing)) {
      models.set(slug, {
        slug,
        creator: slug.split("/")[0],
        name: (r.name ?? slug).replace(/\s*\(free\)\s*$/i, ""),
        description: r.description ?? null,
        inputModalities: r.architecture?.input_modalities ?? [],
        outputModalities: r.architecture?.output_modalities ?? [],
        contextWindow: r.top_provider?.context_length ?? r.context_length ?? null,
        maxOutputTokens: r.top_provider?.max_completion_tokens ?? null,
        supportedParameters: r.supported_parameters ?? [],
        releaseDate: isoDate(r.created),
        knowledgeCutoff: isoDate(r.knowledge_cutoff),
        expirationDate: isoDate(r.expiration_date),
        source: SOURCE,
        sourceUrl: `https://openrouter.ai/${slug}`,
      });
    }
    access.push({ modelSlug: slug, providerId: "openrouter", externalModelId: r.id, source: SOURCE });
    const input = perTokenToPer1m(r.pricing?.prompt);
    const output = perTokenToPer1m(r.pricing?.completion);
    const request = perTokenToPer1m(r.pricing?.request);
    const known = input !== null && output !== null;
    prices.push({
      providerId: "openrouter",
      externalModelId: r.id,
      inputUsdPer1m: input,
      outputUsdPer1m: output,
      requestUsd: request === null ? 0 : request / 1e6,
      status: known ? "verified" : "unknown",
      methodology: known
        ? "OpenRouter's published per-token price for this model id."
        : "OpenRouter lists no fixed per-token price for this id.",
      source: SOURCE,
      sourceUrl: OPENROUTER_CATALOG_URL,
    });
  }
  return { models: [...models.values()], access, prices, skipped };
}

export async function fetchOpenRouterCatalog(fetchImpl: typeof fetch = fetch): Promise<OpenRouterCatalogModel[]> {
  const res = await fetchImpl(OPENROUTER_CATALOG_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`OpenRouter catalog HTTP ${res.status}`);
  const body = (await res.json()) as { data?: OpenRouterCatalogModel[] };
  if (!Array.isArray(body?.data)) throw new Error("OpenRouter catalog: no data array");
  return body.data;
}
