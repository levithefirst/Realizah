import { NextResponse } from "next/server";
import { hasDatabase } from "@/lib/db";
import { configuredAdapters } from "@/lib/providers";
import { loadRegistry, registryStats } from "@/lib/registry/load";
import { isFreeAccess } from "@/lib/selection/select";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Registry summary: what Realizah knows about and what it can run today.
export async function GET() {
  if (!hasDatabase()) return NextResponse.json({ error: "Server is missing DATABASE_URL." }, { status: 503 });
  try {
    const [stats, registry] = await Promise.all([registryStats(), loadRegistry()]);
    const providers = [...configuredAdapters().keys()];
    const executable = registry.filter((m) =>
      m.access.some((a) => providers.includes(a.providerId) && !isFreeAccess(a) && a.priceStatus !== "unknown")
    );
    const byProvider: Record<string, number> = {};
    for (const m of registry) for (const a of m.access) byProvider[a.providerId] = (byProvider[a.providerId] ?? 0) + 1;
    return NextResponse.json({
      discoverableModels: stats.discoverable,
      creators: stats.byCreator,
      accessPathsByProvider: byProvider,
      providersConfigured: providers,
      executableModels: executable.length,
      executableCreators: new Set(executable.map((m) => m.creator)).size,
      textOutputModels: registry.filter((m) => m.outputModalities.includes("text")).length,
      imageOutputModels: registry.filter((m) => m.outputModalities.includes("image")).length,
      lastRefresh: stats.lastRefresh,
    });
  } catch (e) {
    console.error("models stats failed", e);
    return NextResponse.json({ error: "Could not read the registry." }, { status: 500 });
  }
}
