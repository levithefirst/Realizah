// Recent billing overruns per access path, for planning (see billing.ts).
// Rows written before migration 006 have no reserved/billed columns; their
// values are derived the same way the runner computes them.
import "server-only";
import { db } from "../db";
import { ROUTE_BILLING_WINDOW_DAYS, type RouteBillingHistory } from "./billing";

export async function loadRouteBillingHistory(days = ROUTE_BILLING_WINDOW_DAYS): Promise<Map<string, RouteBillingHistory>> {
  const { rows } = await db().query<{ access_id: string; max_ratio: string | null; free_billed: boolean; events: number; last_at: Date }>(
    `with calls as (
       select c.access_id, r.created_at,
              coalesce(res.reserved_cost_usd, case when c.role = 'free_screening' then 0 else c.worst_case_cost_usd end) as reserved,
              coalesce(res.billed_cost_usd, greatest(coalesce(res.estimated_cost_usd, 0), coalesce(res.provider_reported_cost_usd, 0))) as billed
         from comparison_results res
         join comparison_candidates c on c.id = res.candidate_id
         join comparison_runs r on r.id = res.run_id
        where r.created_at > now() - make_interval(days => $1)
     )
     select access_id,
            max(case when reserved > 0 then billed / reserved end) as max_ratio,
            bool_or(reserved = 0) as free_billed,
            count(*)::int as events,
            max(created_at) as last_at
       from calls
      where billed > reserved + 1e-12
      group by access_id`,
    [days]
  );
  return new Map(
    rows.map((r) => [
      r.access_id,
      {
        // A route that reserved $0 (free) and still billed has no finite bound.
        maxRatio: r.free_billed ? Infinity : Number(r.max_ratio ?? 1),
        events: r.events,
        lastAt: new Date(r.last_at).toISOString(),
      },
    ])
  );
}
