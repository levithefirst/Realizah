-- Route-level billing safety: every executed call records what it reserved
-- against the cap and what the provider billed, and whether it billed above
-- the reservation. Recent overruns raise that route's reservation in later
-- plans (lib/comparison/billing.ts). Results are immutable, so rows written
-- before this migration are not backfilled; the history query derives the
-- same values for them from worst_case_cost_usd and the recorded costs.
alter table comparison_results add column if not exists reserved_cost_usd numeric;
alter table comparison_results add column if not exists billed_cost_usd numeric;
alter table comparison_results add column if not exists over_reservation boolean not null default false;
