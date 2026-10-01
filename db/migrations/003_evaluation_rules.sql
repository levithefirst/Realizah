-- Evaluation rule catalog (ids match lib/evaluation/rules.ts).
insert into evaluation_rules (id, version, description, applies_to) values
  ('nonempty.v1', 1, 'The reply is not empty.', 'all'),
  ('not_truncated.v1', 1, 'The reply was not cut off by the output token limit.', 'all'),
  ('no_refusal.v1', 1, 'The reply does not refuse or say "as an AI".', 'all'),
  ('word_count.v1', 1, 'Word count meets the limit or target the task states (targets: within 15%).', 'tasks stating a word count'),
  ('per_item_words.v1', 1, 'Each list item meets the per-item word limit.', 'per-item word limits'),
  ('list_count.v1', 1, 'At least the requested number of list items.', 'tasks asking for N items'),
  ('format_json.v1', 1, 'The reply contains valid JSON.', 'JSON output'),
  ('json_fields.v1', 1, 'Every requested field is present.', 'JSON with named fields'),
  ('format_list.v1', 1, 'The reply uses the requested list format.', 'bullet or numbered lists'),
  ('format_table.v1', 1, 'The reply contains a Markdown table.', 'tables'),
  ('format_csv.v1', 1, 'The reply contains comma-separated rows with a consistent column count.', 'CSV'),
  ('code_present.v1', 1, 'The reply contains code.', 'coding'),
  ('code_language.v1', 1, 'The code is in the requested language.', 'coding with a stated language'),
  ('code_syntax.v1', 1, 'The code parses without syntax errors.', 'JavaScript, TypeScript and JSON code'),
  ('code_tests.v1', 1, 'Tests pass. Not run: Realizah does not execute code yet.', 'coding'),
  ('citations.v1', 1, 'The reply cites sources (links or a references list).', 'tasks requiring sources'),
  ('sections.v1', 1, 'Every named section appears.', 'tasks naming sections'),
  ('must_include.v1', 1, 'Every quoted phrase appears.', 'tasks quoting required phrases'),
  ('language.v1', 1, 'Written in the requested language. Not checked automatically yet.', 'tasks naming a language')
on conflict (id) do nothing;

-- The legacy V1 tables (tools_seed, runs, run_results) are kept read-only for
-- history. tools_seed still supplies hand-verified OpenAI prices to the
-- direct OpenAI access path during refresh.
