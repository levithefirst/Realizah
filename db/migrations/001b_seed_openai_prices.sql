-- Rates are standard-tier text tokens, USD per 1M tokens, copied from the
-- OpenAI model pages on 2026-10-01. If a rate is not published, leave it
-- null and set is_unknown = true. Never guess a number.
insert into tools_seed (slug, name, provider, model_id, pricing_url, input_usd_per_1m, output_usd_per_1m, last_checked, is_unknown) values
  ('gpt-4o-mini',  'GPT-4o mini',  'openai', 'gpt-4o-mini',  'https://openai.com/api/pricing/', 0.15, 0.60, '2026-10-01T00:00:00Z', false),
  ('gpt-4.1-mini', 'GPT-4.1 mini', 'openai', 'gpt-4.1-mini', 'https://openai.com/api/pricing/', 0.40, 1.60, '2026-10-01T00:00:00Z', false),
  ('gpt-4.1-nano', 'GPT-4.1 nano', 'openai', 'gpt-4.1-nano', 'https://openai.com/api/pricing/', 0.10, 0.40, '2026-10-01T00:00:00Z', false)
on conflict (slug) do update set
  name = excluded.name,
  provider = excluded.provider,
  model_id = excluded.model_id,
  pricing_url = excluded.pricing_url,
  input_usd_per_1m = excluded.input_usd_per_1m,
  output_usd_per_1m = excluded.output_usd_per_1m,
  last_checked = excluded.last_checked,
  is_unknown = excluded.is_unknown;
