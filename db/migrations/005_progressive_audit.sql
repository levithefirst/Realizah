-- Progressive comparisons: record every candidate considered for execution,
-- whether it ran or was skipped and why, its role and price tier, and the
-- estimated vs worst-case vs actual spend of the run.
alter table comparison_candidates add column if not exists role text not null default 'core';
alter table comparison_candidates add column if not exists price_tier text;
alter table comparison_candidates add column if not exists stage integer;
alter table comparison_candidates add column if not exists status text not null default 'executed';
alter table comparison_candidates add column if not exists skip_reason text;
alter table comparison_candidates add column if not exists expected_cost_usd numeric;
do $$ begin
  alter table comparison_candidates add constraint comparison_candidates_status_check check (status in ('executed', 'skipped'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table comparison_candidates add constraint comparison_candidates_role_check check (role in ('free_screening', 'core', 'expansion'));
exception when duplicate_object then null; end $$;

alter table comparison_runs add column if not exists candidates_considered integer;
alter table comparison_runs add column if not exists candidates_filtered jsonb;
alter table comparison_runs add column if not exists candidates_queued integer;
alter table comparison_runs add column if not exists candidates_skipped integer not null default 0;
alter table comparison_runs add column if not exists screening_runs integer not null default 0;
alter table comparison_runs add column if not exists charged_execution_cost_usd numeric;
alter table comparison_runs add column if not exists peak_committed_usd numeric;
alter table comparison_runs add column if not exists output_token_ceiling integer;
alter table comparison_runs add column if not exists output_budget_basis text;
alter table comparison_runs add column if not exists stop_reason text;
