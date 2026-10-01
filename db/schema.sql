create extension if not exists pgcrypto;

create table if not exists tools_seed (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  provider text not null,
  model_id text not null,
  pricing_url text,
  input_usd_per_1m numeric,
  output_usd_per_1m numeric,
  last_checked timestamptz,
  is_unknown boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists runs (
  id uuid primary key default gen_random_uuid(),
  current_tool text not null,
  task_text text not null,
  success_criteria jsonb not null default '{}',
  recommended_slug text,
  created_at timestamptz not null default now(),
  ip_hash text
);

create table if not exists run_results (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  tool_slug text not null,
  passed boolean,
  quality_band text,
  estimated_cost_usd numeric,
  cost_per_success_usd numeric,
  latency_ms integer,
  error text,
  created_at timestamptz not null default now()
);

create table if not exists audit_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references runs(id) on delete set null,
  model text not null,
  tokens_in integer,
  tokens_out integer,
  estimated_cost_usd numeric,
  success boolean,
  created_at timestamptz not null default now()
);

create table if not exists rate_limits (
  id text primary key,
  window_start timestamptz not null default now(),
  count integer not null default 0
);

create index if not exists run_results_run_id_idx on run_results (run_id);
create index if not exists audit_events_run_id_idx on audit_events (run_id);
