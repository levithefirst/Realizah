import "server-only";
import { db } from "./db";
import type { AiProduct } from "./products";

export async function listProducts(): Promise<AiProduct[]> {
  const { rows } = await db().query<{
    slug: string;
    name: string;
    aliases: string[];
    capability: AiProduct["capability"];
    baseline_status: AiProduct["baselineStatus"];
    baseline_methodology: string | null;
    baseline_source_url: string | null;
    verified_model_id: string | null;
  }>(
    `select slug, name, aliases, capability, baseline_status, baseline_methodology, baseline_source_url, verified_model_id
       from ai_tools order by name`
  );
  return rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    aliases: r.aliases ?? [],
    capability: r.capability,
    baselineStatus: r.baseline_status,
    baselineMethodology: r.baseline_methodology,
    baselineSourceUrl: r.baseline_source_url,
    verifiedModelId: r.verified_model_id,
  }));
}
