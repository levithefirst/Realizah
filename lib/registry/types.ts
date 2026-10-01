// Registry shapes. A model is an identity; an access path is how a provider
// serves it; a price belongs to an access path at a point in time.

export type Modality = "text" | "image" | "audio" | "video" | "file";

export type PriceStatus = "verified" | "estimated" | "unknown";

export type NormalizedModel = {
  slug: string; // creator/model, the catalog's stable id (":free" collapsed)
  creator: string;
  name: string;
  description: string | null;
  inputModalities: string[];
  outputModalities: string[];
  contextWindow: number | null;
  maxOutputTokens: number | null;
  supportedParameters: string[];
  releaseDate: string | null; // YYYY-MM-DD
  knowledgeCutoff: string | null;
  expirationDate: string | null;
  source: string;
  sourceUrl: string | null;
};

export type NormalizedAccess = {
  modelSlug: string;
  providerId: string;
  externalModelId: string;
  source: string;
};

export type NormalizedPrice = {
  providerId: string;
  externalModelId: string;
  inputUsdPer1m: number | null;
  outputUsdPer1m: number | null;
  requestUsd: number;
  status: PriceStatus;
  methodology: string;
  source: string;
  sourceUrl: string | null;
};

export type NormalizedBenchmark = {
  source: string;
  sourceModelSlug: string;
  sourceModelName: string | null;
  sourceCreator: string | null;
  // Registry slug when the source names the same model exactly; else null.
  modelSlug: string | null;
  metric: string;
  value: number | null;
};

// What selection works with: one row per model with its access paths.
export type RegistryAccess = {
  accessId: string;
  providerId: string;
  externalModelId: string;
  priceId: string | null;
  inputUsdPer1m: number | null;
  outputUsdPer1m: number | null;
  requestUsd: number;
  priceStatus: PriceStatus;
  priceObservedAt: string | null;
  // false when the provider said this id does not serve chat completions.
  chatSupported?: boolean | null;
};

export type RegistryModel = {
  id: string;
  slug: string;
  creator: string;
  name: string;
  inputModalities: string[];
  outputModalities: string[];
  contextWindow: number | null;
  maxOutputTokens: number | null;
  supportedParameters: string[];
  capabilities: string[];
  releaseDate: string | null;
  status: "active" | "stale" | "deprecated";
  benchmarks: Record<string, number>;
  access: RegistryAccess[];
};
