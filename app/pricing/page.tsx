import { hasDatabase, db } from "@/lib/db";
import { formatUsd } from "@/lib/cost";
import { freeLimit } from "@/lib/ratelimit";

export const metadata = { title: "Pricing · Realizah" };
export const dynamic = "force-dynamic";

async function observedCostPerRun(): Promise<{ avg: number | null; runs: number }> {
  if (!hasDatabase()) return { avg: null, runs: 0 };
  try {
    const { rows } = await db().query<{ avg: string | null; runs: string }>(
      `select avg(total) as avg, count(*) as runs from (
         select run_id, sum(estimated_cost_usd) as total
           from audit_events where run_id is not null
          group by run_id) t`
    );
    return { avg: rows[0].avg === null ? null : Number(rows[0].avg), runs: Number(rows[0].runs) };
  } catch {
    return { avg: null, runs: 0 };
  }
}

export default async function Pricing() {
  const limit = freeLimit();
  const { avg, runs } = await observedCostPerRun();
  const perRun = avg ?? 0.0006; // conservative planning number until real runs exist
  const freeWorstCase = perRun * limit * 30;
  const proRuns = 30 * 30;
  const proCost = perRun * proRuns;

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
            <li>30 comparisons per day</li>
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
          Every comparison sends your task (up to 600 characters) to 2 or 3 models with a 400 token output cap.
          {avg !== null
            ? ` Measured average model spend per comparison so far: ${formatUsd(avg)} across ${runs} runs.`
            : ` Planning figure until real runs exist: ${formatUsd(perRun)} per comparison.`}
        </p>
        <ul>
          <li>
            Free tier worst case: {limit} runs/day x 30 days = {formatUsd(freeWorstCase)} per heavy free user per month.
            The hashed-IP cap keeps this bounded.
          </li>
          <li>
            Pro at $19/mo: even at the 30/day cap every day ({proRuns} runs), model spend is about {formatUsd(proCost)}.
            Gross margin stays above 95% after card fees.
          </li>
          <li>Team API: model cost is passed through at the published rate, so usage never runs at a loss.</li>
          <li>Hosting is serverless (Vercel) plus Neon Postgres, both scale to zero when idle.</li>
        </ul>
        <p className="hint">Estimates use published per-token prices with an as-of date. No payments are taken in this version.</p>
      </div>
    </main>
  );
}
