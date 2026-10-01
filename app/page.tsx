import { listProducts } from "@/lib/aiTools";
import type { AiProduct } from "@/lib/products";
import { hasDatabase } from "@/lib/db";
import { freeLimit } from "@/lib/ratelimit";
import Comparer from "@/components/Comparer";

export const dynamic = "force-dynamic";

export default async function Home() {
  let products: AiProduct[] = [];
  let loadError: string | null = null;
  if (!hasDatabase()) {
    loadError = "This deployment has no DATABASE_URL yet.";
  } else {
    try {
      products = await listProducts();
    } catch {
      loadError = "Could not load the tool list from the database. Refresh to retry.";
    }
  }

  return (
    <main>
      <p className="lede">
        Tell us which AI tool you use, what you use it for, and the task. Realizah picks the models relevant to that task, runs your
        exact task on each, checks the results, and shows the Cheaper cost and the Better cost. No account needed for{" "}
        {freeLimit()} comparisons a day.
      </p>
      {loadError ? <div className="alert error">{loadError}</div> : null}
      <Comparer products={products} />
    </main>
  );
}
