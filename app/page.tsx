import { listTools, type Tool } from "@/lib/tools";
import { hasDatabase } from "@/lib/db";
import { DEFAULT_TASK } from "@/lib/fixture";
import { freeLimit } from "@/lib/ratelimit";
import Comparer from "@/components/Comparer";

export const dynamic = "force-dynamic";

export default async function Home() {
  let tools: Tool[] = [];
  let loadError: string | null = null;
  if (!hasDatabase()) {
    loadError = "This deployment has no DATABASE_URL yet, so the tool list is empty.";
  } else {
    try {
      tools = await listTools();
    } catch {
      loadError = "Could not load the tool list from the database. Refresh to retry.";
    }
  }

  return (
    <main>
      <p className="lede">
        Tell us which AI tool you already pay for and what you use it for. We run your task on it and
        on up to two alternatives, check each answer, and show what you pay per answer that actually
        passed. No account needed for {freeLimit()} comparisons a day.
      </p>
      {loadError ? <div className="alert error">{loadError}</div> : null}
      <Comparer tools={tools} defaultTask={DEFAULT_TASK} />
    </main>
  );
}
