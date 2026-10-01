// Artificial Analysis: benchmark and performance data. A data source only,
// never an execution path. Attribution: https://artificialanalysis.ai/
import type { NormalizedBenchmark } from "../types";

export const AA_MODELS_URL = "https://artificialanalysis.ai/api/v2/data/llms/models";
const SOURCE = "artificial_analysis";

type AAModel = {
  slug?: string;
  name?: string;
  model_creator?: { slug?: string; name?: string };
  evaluations?: Record<string, number | null | undefined>;
  median_output_tokens_per_second?: number | null;
  median_time_to_first_token_seconds?: number | null;
};

export async function fetchArtificialAnalysis(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<AAModel[]> {
  const res = await fetchImpl(AA_MODELS_URL, {
    headers: { "x-api-key": apiKey, accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Artificial Analysis HTTP ${res.status}`);
  const body = (await res.json()) as { data?: AAModel[] };
  if (!Array.isArray(body?.data)) throw new Error("Artificial Analysis: no data array");
  return body.data;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9/]+/g, "-").replace(/-+/g, "-").replace(/(^-|-$)/g, "");
}

const METRICS: Record<string, string> = {
  artificial_analysis_intelligence_index: "intelligence_index",
  artificial_analysis_coding_index: "coding_index",
  artificial_analysis_math_index: "math_index",
  gpqa: "gpqa",
  mmlu_pro: "mmlu_pro",
  livecodebench: "livecodebench",
  hle: "hle",
};

// Links a benchmark to a registry model only when creator/slug matches a
// registry slug exactly after punctuation normalization. Otherwise it is
// stored unlinked rather than guessed.
export function normalizeArtificialAnalysis(rows: AAModel[], registrySlugs: string[]): NormalizedBenchmark[] {
  const bySlug = new Map(registrySlugs.map((s) => [norm(s), s]));
  const out: NormalizedBenchmark[] = [];
  for (const r of rows) {
    if (!r.slug) continue;
    const creator = r.model_creator?.slug ?? null;
    const key = creator ? norm(`${creator}/${r.slug}`) : null;
    const modelSlug = key ? bySlug.get(key) ?? null : null;
    const push = (metric: string, value: number | null | undefined) =>
      out.push({
        source: SOURCE,
        sourceModelSlug: creator ? `${creator}/${r.slug}` : r.slug!,
        sourceModelName: r.name ?? null,
        sourceCreator: r.model_creator?.name ?? null,
        modelSlug,
        metric,
        value: typeof value === "number" && Number.isFinite(value) ? value : null,
      });
    for (const [k, metric] of Object.entries(METRICS)) {
      if (r.evaluations && k in r.evaluations) push(metric, r.evaluations[k]);
    }
    if (r.median_output_tokens_per_second !== undefined) push("output_tokens_per_second", r.median_output_tokens_per_second);
    if (r.median_time_to_first_token_seconds !== undefined) push("time_to_first_token_s", r.median_time_to_first_token_seconds);
  }
  return out;
}
