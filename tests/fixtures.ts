import type { ExecutionLimits } from "../lib/config";
import type { RegistryAccess, RegistryModel } from "../lib/registry/types";

// Generous limits for selection tests; progressive tests use their own.
export const LIMITS: ExecutionLimits = {
  maxCandidates: 20,
  minCandidates: 4,
  maxExecutionCostUsd: 1,
  maxCostPerCandidateUsd: 1,
  maxOutputTokens: 4096,
  timeoutMs: 1000,
  maxConcurrent: 4,
  reasoningHeadroomTokens: 1024,
  freeScreeningModels: 2,
};

// The production defaults (MAX_CANDIDATES_PER_RUN=10, MAX_EXECUTION_COST_USD=0.03, ...).
export const DEFAULT_LIMITS: ExecutionLimits = {
  maxCandidates: 10,
  minCandidates: 4,
  maxExecutionCostUsd: 0.03,
  maxCostPerCandidateUsd: 0.01,
  maxOutputTokens: 4096,
  timeoutMs: 1000,
  maxConcurrent: 5,
  reasoningHeadroomTokens: 1024,
  freeScreeningModels: 2,
};

let seq = 0;
export function access(provider: string, external: string, input: number | null, output: number | null, status: RegistryAccess["priceStatus"] = "verified"): RegistryAccess {
  seq++;
  return {
    accessId: `acc-${seq}`,
    providerId: provider,
    externalModelId: external,
    priceId: `price-${seq}`,
    inputUsdPer1m: input,
    outputUsdPer1m: output,
    requestUsd: 0,
    priceStatus: input === null || output === null ? "unknown" : status,
    priceObservedAt: "2026-10-01T00:00:00.000Z",
  };
}

export function model(slug: string, opts: Partial<RegistryModel> & { price?: [number, number]; providers?: string[] } = {}): RegistryModel {
  const [input, output] = opts.price ?? [0.5, 1.5];
  return {
    id: `id-${slug}`,
    slug,
    creator: slug.split("/")[0],
    name: slug,
    inputModalities: ["text"],
    outputModalities: ["text"],
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    supportedParameters: ["max_tokens", "temperature"],
    capabilities: ["text_generation"],
    releaseDate: "2026-06-01",
    status: "active",
    benchmarks: {},
    access: opts.access ?? (opts.providers ?? ["openrouter"]).map((p) => access(p, p === "openrouter" ? slug : slug.split("/")[1], input, output)),
    ...opts,
  };
}

// A registry shaped like the real catalog: many creators, mixed prices,
// some image-only models, some free variants and dated near-duplicates.
export function bigRegistry(n = 300): RegistryModel[] {
  const creators = ["openai", "anthropic", "google", "deepseek", "x-ai", "qwen", "mistralai", "meta-llama", "cohere", "amazon", "moonshotai", "z-ai"];
  const out: RegistryModel[] = [];
  for (let i = 0; i < n; i++) {
    const c = creators[i % creators.length];
    const price = 0.05 + (i % 17) * 0.4;
    out.push(
      model(`${c}/model-${i}`, {
        price: [price, price * 3],
        benchmarks: { intelligence_index: 20 + (i % 40), coding_index: 10 + ((i * 7) % 50) },
        capabilities: i % 3 === 0 ? ["text_generation", "reasoning"] : ["text_generation"],
        releaseDate: i % 5 === 0 ? "2024-01-01" : "2026-05-01",
      })
    );
  }
  out.push(model("openai/image-only", { outputModalities: ["image"], capabilities: ["image_generation"] }));
  out.push(model("google/free-only", { access: [access("openrouter", "google/free-only:free", 0, 0)] }));
  out.push(model("openai/model-0-2024-07-18", { price: [0.05, 0.15] })); // near-duplicate of openai/model-0
  return out;
}
