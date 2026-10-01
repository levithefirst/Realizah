import { listAiTools } from "@/lib/aiTools";
import type { AiTool } from "@/lib/support";
import { hasDatabase } from "@/lib/db";
import { DEFAULT_TASK } from "@/lib/fixture";
import { freeLimit } from "@/lib/ratelimit";
import Comparer from "@/components/Comparer";

export const dynamic = "force-dynamic";

export default async function Home() {
  let aiTools: AiTool[] = [];
  let loadError: string | null = null;
  if (!hasDatabase()) {
    loadError = "This deployment has no DATABASE_URL yet, so the tool list is empty.";
  } else {
    try {
      aiTools = await listAiTools();
    } catch {
      loadError = "Could not load the tool list from the database. Refresh to retry.";
    }
  }

  return (
    <main>
      <p className="lede">
        Tell us which AI tool you pay for, what you use it for, and the task to compare. For
        text-generation tasks we run the task on OpenAI models, check each answer, and mark the Cheaper
        cost and the Better cost. No account needed for {freeLimit()} comparisons a day.
      </p>
      {loadError ? <div className="alert error">{loadError}</div> : null}
      <Comparer aiTools={aiTools} defaultTask={DEFAULT_TASK} />
    </main>
  );
}
