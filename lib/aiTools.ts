import { db } from "./db";
import type { AiTool, Capability } from "./support";

export async function listAiTools(): Promise<AiTool[]> {
  const { rows } = await db().query<{
    slug: string;
    name: string;
    aliases: string[];
    capability: Capability;
    verified_model_slug: string | null;
  }>(
    `select slug, name, aliases, capability, verified_model_slug
       from ai_tools
      order by name`
  );
  return rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    aliases: r.aliases ?? [],
    capability: r.capability,
    verifiedModelSlug: r.verified_model_slug,
  }));
}
