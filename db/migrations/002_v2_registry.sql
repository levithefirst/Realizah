-- Realizah V2: products, models and providers are separate things.
--   ai_tools        what the user says they use (a product, not a model)
--   providers       who we can call (execution) or read from (data)
--   models          a model's identity and verified metadata
--   model_provider_access  a model reachable through a provider, by that provider's id
--   model_prices    versioned prices per access path (a new row when the price changes)
--   model_capabilities     capabilities derived from source metadata, never from names
--   model_benchmarks       benchmark signals (selection hints, never proof of task quality)
--   model_snapshots        raw source payloads, stored when they change
--   registry_refreshes     one row per refresh run; comparisons point at the one they used
-- Nothing in the registry is ever deleted: unseen models are marked stale.

create table if not exists providers (
  id text primary key,
  name text not null,
  kind text not null check (kind in ('execution', 'data')),
  base_url text,
  created_at timestamptz not null default now()
);

insert into providers (id, name, kind, base_url) values
  ('openrouter', 'OpenRouter', 'execution', 'https://openrouter.ai/api/v1'),
  ('openai', 'OpenAI', 'execution', 'https://api.openai.com/v1'),
  ('artificial_analysis', 'Artificial Analysis', 'data', 'https://artificialanalysis.ai/api/v2')
on conflict (id) do nothing;

create table if not exists registry_refreshes (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'ok', 'partial', 'error', 'skipped')),
  sources jsonb not null default '{}',
  models_seen integer not null default 0,
  models_new integer not null default 0,
  prices_changed integer not null default 0,
  marked_stale integer not null default 0,
  error text
);
create index if not exists registry_refreshes_started_idx on registry_refreshes (started_at desc);

create table if not exists models (
  id uuid primary key default gen_random_uuid(),
  -- Stable id in the creator/model namespace used by the catalog, e.g. "openai/gpt-4o-mini".
  slug text unique not null,
  creator text not null,
  name text not null,
  description text,
  input_modalities text[] not null default '{}',
  output_modalities text[] not null default '{}',
  context_window integer,
  max_output_tokens integer,
  supported_parameters text[] not null default '{}',
  release_date date,
  knowledge_cutoff date,
  expiration_date date,
  status text not null default 'active' check (status in ('active', 'stale', 'deprecated')),
  source text not null,
  source_url text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  verified_at timestamptz not null default now()
);
create index if not exists models_status_idx on models (status);
create index if not exists models_creator_idx on models (creator);

create table if not exists model_provider_access (
  id uuid primary key default gen_random_uuid(),
  model_id uuid not null references models(id),
  provider_id text not null references providers(id),
  external_model_id text not null,
  available boolean not null default true,
  source text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  verified_at timestamptz not null default now(),
  unique (provider_id, external_model_id)
);
create index if not exists model_provider_access_model_idx on model_provider_access (model_id);

create table if not exists model_prices (
  id uuid primary key default gen_random_uuid(),
  access_id uuid not null references model_provider_access(id),
  input_usd_per_1m numeric,
  output_usd_per_1m numeric,
  request_usd numeric not null default 0,
  -- verified: from the provider's own published price for this access path
  -- estimated: from another documented source (see methodology)
  -- unknown: no usable price
  price_status text not null check (price_status in ('verified', 'estimated', 'unknown')),
  methodology text,
  source text not null,
  source_url text,
  observed_at timestamptz not null default now(),
  refresh_id uuid references registry_refreshes(id)
);
create index if not exists model_prices_access_observed_idx on model_prices (access_id, observed_at desc);

create table if not exists model_capabilities (
  model_id uuid not null references models(id),
  capability text not null,
  source text not null,
  verified_at timestamptz not null default now(),
  primary key (model_id, capability)
);

create table if not exists model_benchmarks (
  id uuid primary key default gen_random_uuid(),
  model_id uuid references models(id),
  source text not null,
  source_model_slug text not null,
  source_model_name text,
  source_creator text,
  metric text not null,
  value numeric,
  observed_on date not null default current_date,
  unique (source, source_model_slug, metric, observed_on)
);
create index if not exists model_benchmarks_model_idx on model_benchmarks (model_id, metric);

create table if not exists model_snapshots (
  id uuid primary key default gen_random_uuid(),
  refresh_id uuid references registry_refreshes(id),
  source text not null,
  source_key text not null,
  payload_hash text not null,
  payload jsonb not null,
  observed_at timestamptz not null default now(),
  unique (source, source_key, payload_hash)
);

-- Current-tool baseline. A product's per-task cost is unknown unless verified.
alter table ai_tools add column if not exists baseline_status text not null default 'unknown';
alter table ai_tools add column if not exists baseline_methodology text;
alter table ai_tools add column if not exists baseline_source_url text;
alter table ai_tools add column if not exists baseline_verified_at timestamptz;
alter table ai_tools add column if not exists verified_model_id uuid references models(id);
do $$ begin
  alter table ai_tools add constraint ai_tools_baseline_status_check
    check (baseline_status in ('verified', 'estimated', 'unknown'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table ai_tools add constraint ai_tools_verified_model_is_sourced
    check (verified_model_id is null or (mapping_source_url is not null and mapping_verified_at is not null));
exception when duplicate_object then null; end $$;

-- Comparisons. Results are immutable once written (retention may delete whole runs).
create table if not exists comparison_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  ai_tool_input text not null,
  ai_tool_slug text,
  use_case text not null,
  task_text text not null,
  task_understanding jsonb not null,
  baseline jsonb not null,
  budget_usd numeric,
  execution_budget_usd numeric not null,
  estimated_execution_cost_usd numeric,
  actual_execution_cost_usd numeric,
  candidate_count integer not null,
  models_attempted integer not null default 0,
  models_succeeded integer not null default 0,
  models_failed integer not null default 0,
  registry_refresh_id uuid references registry_refreshes(id),
  cheaper_cost_model_ids uuid[] not null default '{}',
  better_cost_model_ids uuid[] not null default '{}',
  status text not null default 'complete' check (status in ('complete', 'partial', 'no_candidates')),
  ip_hash text
);
create index if not exists comparison_runs_created_idx on comparison_runs (created_at);

create table if not exists comparison_candidates (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references comparison_runs(id) on delete cascade,
  model_id uuid not null references models(id),
  access_id uuid not null references model_provider_access(id),
  provider_id text not null references providers(id),
  external_model_id text not null,
  price_id uuid references model_prices(id),
  input_usd_per_1m numeric,
  output_usd_per_1m numeric,
  price_status text not null,
  selection_rank integer not null,
  selection_reason text not null,
  max_output_tokens integer not null,
  worst_case_cost_usd numeric
);
create index if not exists comparison_candidates_run_idx on comparison_candidates (run_id);

create table if not exists comparison_results (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references comparison_runs(id) on delete cascade,
  candidate_id uuid not null references comparison_candidates(id) on delete cascade,
  executed boolean not null,
  passed boolean,
  input_tokens integer,
  output_tokens integer,
  total_tokens integer,
  input_usd_per_1m numeric,
  output_usd_per_1m numeric,
  estimated_cost_usd numeric,
  provider_reported_cost_usd numeric,
  cost_per_success_usd numeric,
  latency_ms integer,
  finish_reason text,
  evaluation jsonb not null default '[]',
  error text,
  created_at timestamptz not null default now()
);
create index if not exists comparison_results_run_idx on comparison_results (run_id);

create table if not exists budget_plans (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references comparison_runs(id) on delete cascade,
  candidate_id uuid not null references comparison_candidates(id) on delete cascade,
  budget_usd numeric not null,
  cost_per_success_usd numeric,
  successful_runs_within_budget integer,
  exceeds_budget boolean not null,
  is_estimate boolean not null default true
);

create table if not exists evaluation_rules (
  id text primary key,
  version integer not null,
  description text not null,
  applies_to text not null,
  created_at timestamptz not null default now()
);

create or replace function realizah_block_update() returns trigger language plpgsql as $$
begin
  raise exception 'comparison history is immutable (% on %)', tg_op, tg_table_name;
end $$;
drop trigger if exists comparison_results_immutable on comparison_results;
create trigger comparison_results_immutable before update on comparison_results
  for each row execute function realizah_block_update();
drop trigger if exists comparison_candidates_immutable on comparison_candidates;
create trigger comparison_candidates_immutable before update on comparison_candidates
  for each row execute function realizah_block_update();

-- Every model execution, for spend reconciliation.
alter table audit_events add column if not exists comparison_run_id uuid references comparison_runs(id) on delete set null;
alter table audit_events add column if not exists provider_id text;
alter table audit_events add column if not exists total_tokens integer;
alter table audit_events add column if not exists input_usd_per_1m numeric;
alter table audit_events add column if not exists output_usd_per_1m numeric;
alter table audit_events add column if not exists latency_ms integer;
alter table audit_events add column if not exists evaluation_passed boolean;
create index if not exists audit_events_comparison_run_idx on audit_events (comparison_run_id);
