// Route-level billing safety.
//
// Every call reserves a worst case before it launches (input bound + max
// output tokens at the route's price). Some routes bill more than that bound:
// OpenRouter's openai/gpt-6.1-sol-pro billed ~1,800 hidden input tokens for
// an 11-word prompt and 455 output tokens against max_tokens 198. So after
// every call the actual bill is compared with the reservation, and an
// overrun is recorded on the result row.
//
// Within a comparison the route is unsafe and never launched again. Across
// comparisons, a route with a recent overrun keeps competing but reserves its
// observed overrun ratio (plus a margin), so the normal cap check decides
// whether it still fits. Observations older than the window are ignored: one
// anomaly never blacklists a model for good.
import type { CandidateOutcome } from "./execute";

export const ROUTE_BILLING_WINDOW_DAYS = 7;
// Headroom on top of the worst overrun ratio observed for a route.
export const RESERVATION_MARGIN = 1.25;
const EPS = 1e-12;

// Recent overruns of one access path. maxRatio is billed / reserved; Infinity
// when a route reserved $0 (a free route) and still billed.
export type RouteBillingHistory = { maxRatio: number; events: number; lastAt: string };

// What the provider billed for a call: its own reported cost when it gives
// one, never less than what the token counts and price snapshot imply.
export function billedCostUsd(o: Pick<CandidateOutcome, "estimatedCostUsd" | "run">): number {
  return Math.max(o.estimatedCostUsd ?? 0, o.run.providerReportedCostUsd ?? 0);
}

export function isOverReservation(billedUsd: number, reservedUsd: number): boolean {
  return billedUsd > reservedUsd + EPS;
}

// Multiplier on a route's worst case for planning: 1 for a clean route.
export function reservationFactor(h: RouteBillingHistory | undefined): number {
  if (!h) return 1;
  return Math.max(1, h.maxRatio * RESERVATION_MARGIN);
}
