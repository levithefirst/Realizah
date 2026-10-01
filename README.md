# Realizah

**Live:** https://realizah.vercel.app · **Health:** https://realizah.vercel.app/health ·
**Registry:** https://realizah.vercel.app/api/models

Realizah shows you the cheaper cost or better cost of whatever AI tool you are using. Tell it the tool, what you
use it for, and the task. It works out what the task needs, picks up to 20 relevant models from a registry built
from live catalogs, sends every one of them your exact task, checks each result with task-aware rules, and
reports two things only:

- **Cheaper cost**: the lowest estimated dollars for this run (pass or fail).
- **Better cost**: the lowest dollars per successful outcome. A failed result has none; if nothing passes,
  there is no Better cost.

Original work for Galuxium Nexus V2. All IP retained by the author.

## Architecture

```
user tool + use case + task
  -> task understanding      lib/task/understand.ts      deterministic classifier + constraint extraction
  -> model registry          lib/registry/*              models, access paths, versioned prices, capabilities
  -> capability filter       lib/selection/select.ts     modality, context, output length (verified metadata only)
  -> access + price filter                               configured providers, known prices, no free tiers
  -> budget filters                                      user budget, then Realizah's execution budget
  -> candidate selection                                 relevance signals + creator diversity + price spread
  -> same task to each       lib/comparison/execute.ts   one user message, unchanged, bounded concurrency
  -> provider adapters       lib/providers/*             OpenRouter, OpenAI (normalized results)
  -> evaluation              lib/evaluation/*            versioned deterministic rules; pass/fail/not checked
  -> cost                    lib/pricing.ts              tokens x the candidate's price snapshot
  -> labels                  lib/labels.ts               Cheaper cost, Better cost
  -> audit trail             lib/comparison/service.ts   comparison_runs/candidates/results, audit_events
```

**Products, models and providers are separate.** An AI product (ChatGPT, Cursor, Higgsfield) is what the user
pays for; it is not a model. A model is an identity with metadata. A provider is an access path to a model,
with its own id and price. One model can have several access paths.

**Discovery, execution and evaluation are separate.** The OpenRouter catalog and OpenAI's models API discover
models and prices. Artificial Analysis (optional) adds benchmark signals; it never executes anything. Execution
goes through provider adapters. Evaluation runs on the actual outputs.

## Model registry and daily refresh

`GET /api/cron/refresh-models` runs daily at 06:17 UTC (Vercel Cron, `vercel.json`). Each source is
independent; a failing source is recorded and its last snapshot stays in use.

| Source | Gives | Key |
| --- | --- | --- |
| OpenRouter catalog (`/api/v1/models`, public) | models, modalities, context, max output, supported parameters, per-token prices for the OpenRouter path | none |
| OpenAI `/v1/models` | which OpenAI ids our key can call; linked to registry models by exact id only | `OPENAI_API_KEY` |
| Artificial Analysis | intelligence/coding/math indexes, speed; linked only on exact creator/slug match | `ARTIFICIAL_ANALYSIS_API_KEY` |

- Prices are versioned: a new `model_prices` row only when a price changes. Each row has a status
  (`verified`, `estimated`, `unknown`), methodology, source and timestamp. Variable or missing prices stay
  unknown and are never selected.
- Direct OpenAI prices: hand-verified ones (legacy `tools_seed`) are `verified`; others reuse OpenRouter's
  price for the same OpenAI model and are marked `estimated` with that methodology.
- Capabilities come from metadata only (modalities and accepted parameters), never from a model's name.
- Models and access paths not seen in a refresh are marked stale or unavailable, never deleted. Raw source
  payloads are kept in `model_snapshots` whenever they change, and every comparison stores the refresh id and
  the exact prices it used, so past results never change when prices do.

## Task understanding

Deterministic rules classify the task (writing, coding, reasoning, research, extraction, summarization,
structured JSON, mathematics, analysis, agentic, image/video/audio generation, image understanding,
speech-to-text, text-to-speech) by what it asks to produce, not by keywords alone ("a cold email offering an
AI video service" is writing). It extracts explicit constraints: word count (limit, minimum, range, target,
per item), output format, natural language, code language, framework, citations, sections, item count,
required phrases, JSON fields, tools, web access, and required input files. No LLM classifier is used, so it
adds no cost.

Not executable yet, and said so plainly: image, video and audio generation; tasks needing an uploaded image or
audio file; agentic tasks needing tools or browsing. Text models are never offered as a substitute.

## Candidate selection

1. Capability: the model outputs the required modality, takes text, and its context window and max output fit.
2. Access: at least one configured provider serves it at a known price (cheapest path wins; a direct
   provider wins ties). Free tiers are excluded: they are rate limited and not a stable price.
3. Budget: models whose single task would exceed the user's budget are listed and excluded; then candidates
   are added only while total worst-case spend stays under `MAX_EXECUTION_COST_USD`.
4. Relevance (signals, never proof): the benchmark relevant to the task, verified reasoning or structured-output
   support where the task needs it, and freshness. Near-duplicates (dated snapshots, variants) are collapsed.
5. Diversity: round-robin across model creators with a per-creator cap, plus a quarter of the slots for the
   cheapest capable models so the price range is represented.

Up to `MAX_CANDIDATES_PER_RUN` (20) are selected; fewer when fewer are relevant or affordable.

## Same task, same input

Every candidate receives one user message containing the task exactly as typed: no rewriting, no wrapper, no
fixture. The only per-model differences are execution requirements: reasoning-capable models get extra output
token headroom for their hidden reasoning, and each adapter uses its provider's parameter names.

## Evaluation

Versioned rules (`lib/evaluation/rules.ts`, table `evaluation_rules`): non-empty, not truncated, no refusal or
"as an AI", word count (targets within 15%), per-item limits, item count, JSON validity and required fields,
list/table/CSV format, code present, code language, JavaScript/TypeScript/JSON syntax, citations, sections,
required phrases. A reply passes when every checkable rule passes. Rules Realizah cannot verify yet (running
code tests, checking the language) are shown as "not checked" and never affect pass/fail. There is no quality
score.

## Cost, labels, baseline and budget

- Estimated cost = `(input tokens x input price + output tokens x output price) / 1,000,000 + per-request fee`,
  using the candidate's price snapshot. Provider-reported cost is stored for reconciliation only.
- $/success = estimated cost when the result passed; otherwise unavailable.
- Current tool baseline: a product's per-task cost is `unknown` unless the product has a stored, sourced model
  mapping and that model ran with a known price. Today no mappings are stored, so results say "Current tool
  cost unavailable" and never claim a model is cheaper than the user's tool.
- Budget (optional, e.g. $20) is hypothetical: Realizah estimates successful runs it would buy
  (`floor(budget / $per success)`, labeled as an estimate from one run) and flags models over budget. It never
  spends it. Realizah's own spend is capped separately by `MAX_EXECUTION_COST_USD`.

## Safety limits

`MAX_CANDIDATES_PER_RUN` (20), `MAX_EXECUTION_COST_USD` ($0.10 worst case per comparison, checked before any
call), `MAX_OUTPUT_TOKENS` (4096), `TIMEOUT_MS` (60s per model), `MAX_CONCURRENT_MODELS` (8),
3 free comparisons per day per hashed IP. Unsupported tasks and empty candidate sets are refused before any
spend or rate-limit use. All execution is server-side; keys never reach the browser.

## API

- `POST /api/plan` (or `GET /api/plan?tool=&useCase=&task=`) task understanding and candidate selection,
  no model calls.
- `POST /api/run` `{ tool, useCase, task, budgetUsd?, wordMax? }` runs the comparison.
- `GET /api/models` registry counts: discoverable, executable, by provider, last refresh.
- `GET /api/cron/refresh-models` daily refresh (Bearer `CRON_SECRET` if set; otherwise at most hourly).
- `GET /health`

## Schema

Migrations in `db/migrations/` (applied in order by `npm run db:setup`, tracked in `schema_migrations`):
`ai_tools`, `providers`, `models`, `model_provider_access`, `model_prices`, `model_capabilities`,
`model_benchmarks`, `model_snapshots`, `registry_refreshes`, `comparison_runs`, `comparison_candidates`,
`comparison_results` (immutable: updates are rejected by trigger), `budget_plans`, `evaluation_rules`,
`audit_events`, `rate_limits`. V1 tables (`tools_seed`, `runs`, `run_results`) are kept for history.

## Governance

- Keys only in server env; nothing provider-related is in `NEXT_PUBLIC_*` or the client bundle.
- Stored: tool name, use case, task text, task understanding, selected models, token counts, prices, costs,
  evaluation results, hashed IP. Model outputs are shown to the user and not stored.
- Comparison data is deleted after 14 days; registry history is kept.
- Benchmarks select candidates; they are never presented as proof that a model did the user's task better.

## Local run and tests

```bash
npm install
cp .env.example .env              # DATABASE_URL plus at least one execution key
node --env-file=.env scripts/db-setup.mjs
npm run dev                       # then GET /api/cron/refresh-models once to fill the registry
npm test                          # unit + integration (PGlite Postgres, mocked providers; no network)
npm run build
```

## Not supported yet

Image, video and audio generation comparisons; file uploads (image understanding, transcription); agentic
tasks with tools or browsing; executing generated code or tests; automatic language verification; current-tool
cost for consumer products without a verified model mapping.
