-- Phase 2 evidence.
-- 1. Content kept with each result until retention removes it
--    (lib/comparison/service.ts applyRetention): the model's reply and the full
--    wording of its checks, which can quote the task or the reply. In its own
--    table because comparison_results is immutable; comparison_results keeps
--    content-free check details permanently.
create table if not exists comparison_outputs (
  result_id uuid primary key references comparison_results(id) on delete cascade,
  run_id uuid not null references comparison_runs(id) on delete cascade,
  output_text text not null,
  checks jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists comparison_outputs_created_idx on comparison_outputs (created_at);

-- 2. Runs are no longer deleted after 14 days; their typed content is scrubbed
--    and this marks when.
alter table comparison_runs add column if not exists content_deleted_at timestamptz;
create index if not exists comparison_runs_created_idx on comparison_runs (created_at);

-- 3. Correctness rules (ids match lib/evaluation/rules.ts).
insert into evaluation_rules (id, version, description, applies_to) values
  ('math_answer.v1', 1, 'The reply states the correct value when the task''s arithmetic can be computed; otherwise not checked.', 'mathematics and reasoning'),
  ('extraction_values.v1', 1, 'Every number, phone number, email and link in the reply appears in the task''s source text.', 'extraction'),
  ('extraction_text.v1', 1, 'Extracted text values appear verbatim in the source; rephrased values are not checked.', 'extraction')
on conflict (id) do nothing;
