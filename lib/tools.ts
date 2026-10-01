import { db } from "./db";

export type Tool = {
  slug: string;
  name: string;
  provider: string;
  modelId: string;
  pricingUrl: string | null;
  inputUsdPer1m: number | null;
  outputUsdPer1m: number | null;
  lastChecked: string | null;
  isUnknown: boolean;
};

type Row = {
  slug: string;
  name: string;
  provider: string;
  model_id: string;
  pricing_url: string | null;
  input_usd_per_1m: string | null;
  output_usd_per_1m: string | null;
  last_checked: Date | null;
  is_unknown: boolean;
};

function num(v: string | null): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function listTools(): Promise<Tool[]> {
  const { rows } = await db().query<Row>(
    `select slug, name, provider, model_id, pricing_url, input_usd_per_1m,
            output_usd_per_1m, last_checked, is_unknown
       from tools_seed
      order by name`
  );
  return rows.map((r) => {
    const input = num(r.input_usd_per_1m);
    const output = num(r.output_usd_per_1m);
    return {
      slug: r.slug,
      name: r.name,
      provider: r.provider,
      modelId: r.model_id,
      pricingUrl: r.pricing_url,
      inputUsdPer1m: r.is_unknown ? null : input,
      outputUsdPer1m: r.is_unknown ? null : output,
      lastChecked: r.last_checked ? r.last_checked.toISOString() : null,
      isUnknown: r.is_unknown || input === null || output === null,
    };
  });
}
