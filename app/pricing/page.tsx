import { hasDatabase, db } from "@/lib/db";
import { formatUsd } from "@/lib/pricing";
import { freeLimit } from "@/lib/ratelimit";
import { executionLimits } from "@/lib/config";

export const metadata = { title: "Pricing · Realizah" };
export const dynamic = "force-dynamic";

async function observedCostPerRun(): Promise<{ avg: number | null; runs: number }> {
  if (!hasDatabase()) return { avg: null, runs: 0 };
  try {
    const { rows } = await db().query<{ avg: string | null; runs: string }>(
      `select avg(actual_execution_cost_usd) as avg, count(*) as runs
         from comparison_runs where actual_execution_cost_usd is not null`
    );
    return { avg: rows[0].avg === null ? null : Number(rows[0].avg), runs: Number(rows[0].runs) };
  } catch {
    return { avg: null, runs: 0 };
  }
}

export default async function Pricing() {
  const limit = freeLimit();
  const { avg, runs } = await observedCostPerRun();
  const cap = executionLimits().maxExecutionCostUsd; // hard ceiling per comparison
  const PRO_RUNS_PER_MONTH = 60;
  const freeWorstCase = cap * limit * 30;
  const proWorstCase = cap * PRO_RUNS_PER_MONTH;
  const proTypical = avg !== null ? avg * PRO_RUNS_PER_MONTH : null;

  return (
    <main>
      <div className="prose">
        <h1 style={{ fontSize: 24, margin: "0 0 8px" }}>Pricing</h1>
        <p className="lede">Start free. Pay only when you want history, exports, or an API.</p>
      </div>

      <div className="plans">
        <div className="panel plan">
          <h2>Free</h2>
          <div className="amount">$0</div>
          <ul>
            <li>{limit} comparisons per day</li>
            <li>No account</li>
            <li>Full result cards and audit strip</li>
          </ul>
          <a href="/"><button className="primary" type="button">Run a comparison</button></a>
        </div>
        <div className="panel plan">
          <h2>Pro</h2>
          <div className="amount">$19<span style={{ fontSize: 14, fontWeight: 400 }}>/mo</span></div>
          <ul>
            <li>60 comparisons per month</li>
            <li>Run history</li>
            <li>CSV export</li>
          </ul>
          <button className="ghost" type="button" disabled>Pro checkout in next pass</button>
        </div>
        <div className="panel plan">
          <h2>Team API</h2>
          <div className="amount">Usage-based</div>
          <ul>
            <li>Call comparisons from your own pipeline</li>
            <li>Model spend passed through at cost plus a flat platform fee</li>
            <li>Shared history across your team</li>
          </ul>
          <button className="ghost" type="button" disabled>Talk to us in next pass</button>
        </div>
      </div>

      <div className="panel prose" style={{ marginTop: 20, maxWidth: "none" }}>
        <h2 style={{ marginTop: 0 }}>How the money works</h2>
        <p>
          A comparison runs your task on up to {executionLimits().maxCandidates} relevant models. Realizah estimates the worst-case
          cost before calling anything and never lets one comparison exceed {formatUsd(cap)} of model spend.
          {avg !== null
            ? ` Measured average spend so far: ${formatUsd(avg)} per comparison across ${runs} runs.`
            : " No measured average yet; figures below use the hard ceiling."}
        </p>
        <ul>
          <li>
            Free tier ceiling: {limit} runs/day x 30 days x {formatUsd(cap)} = {formatUsd(freeWorstCase)} per heavy free user per month,
            bounded by the hashed-IP limit.
          </li>
          <li>
            Pro at $19/mo, {PRO_RUNS_PER_MONTH} comparisons: at most {formatUsd(proWorstCase)} of model spend
            {proTypical !== null ? `, about ${formatUsd(proTypical)} at the measured average` : ""}.
            {proWorstCase < 19 ? " Spend stays under the price even at the ceiling." : " At the ceiling this would not cover model spend, so the cap or price must change before launch."}
          </li>
          <li>Team API: model cost is passed through at the published rate, so usage never runs at a loss.</li>
          <li>Hosting is serverless (Vercel) plus Neon Postgres, both scale to zero when idle.</li>
        </ul>
        <p className="hint">Estimates use published per-token prices with an as-of date. No payments are taken in this version.</p>
      </div>
    </main>
  );
}
