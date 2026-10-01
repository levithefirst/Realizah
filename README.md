# Realizah

**Live:** LIVE_URL_PLACEHOLDER
**Health:** LIVE_URL_PLACEHOLDER/health

You already pay for an AI tool. Realizah tells you what you pay for each answer that actually works.
Type "I use X for Y", pick up to two alternatives, and hit run. Realizah makes real model calls on a
short fixture, checks each answer, and shows dollars per successful outcome with a Recommended badge.
No login for the first result.

Original work for Galuxium Nexus V2. All IP retained by the author.

## Problem

Teams pick an AI tool once and keep paying for it. Price pages list dollars per million tokens, which says
nothing about whether the cheaper model actually does your task. A model that is half the price but fails
half the time costs the same per useful answer, plus the cleanup. Nobody measures cost per *successful*
outcome on their own task before renewing.

## Who it's for

- Ops and support leads who use an AI tool for one repeated job (summaries, triage, replies) and want to know
  if a cheaper option does that job just as well.
- Founders and finance owners checking an AI line item before it grows.
- Engineers who want a fast sanity check before swapping a model id in production.

## How it works

1. You type `I use [tool] for [task]`. The default task: summarize a short brief in 80 words or fewer with no
   invented facts.
2. You pick the model behind your current tool and up to two alternatives from the seeded list.
3. The server runs your task on a ~150 word fictional support ticket (never your files) for each model in
   parallel. Max 400 output tokens, 25 second timeout per model.
4. Each answer is checked: word cap (default 80) and must not contain "as an AI".
5. Estimated cost = `(tokens_in * input_rate + tokens_out * output_rate) / 1,000,000` from `tools_seed`.
6. `cost_per_success_usd` = estimated cost if the answer passed, otherwise null. Failed answers are never
   "cheap".
7. The passing option with the lowest cost per success gets the Recommended badge. If nothing passes, there is
   no recommendation and the page says so.
8. If a model id returns 404 on the key, the run falls back to `gpt-4o-mini` at temperature 0.9 and labels the
   card clearly as a fallback.

## Architecture

```
Browser ──> Vercel (Next.js App Router)
              ├─ /              server component loads tools_seed, client form posts to /api/run
              ├─ /api/run       rate limit -> parallel OpenAI calls -> checks -> cost -> Postgres txn
              ├─ /api/tools     seeded models and prices
              ├─ /health        { "ok": true }
              └─ /pricing /privacy /terms
                    │                         │
                    ▼                         ▼
          OpenAI Chat Completions      Neon Postgres (pooled, sslmode=require)
          (gpt-4o-mini, gpt-4.1-mini,  tools_seed, runs, run_results,
           gpt-4.1-nano)               audit_events, rate_limits
```

- **Vercel**: one Next.js app, API routes in the same deploy. Node runtime, `maxDuration` 60s.
- **Neon**: `pg` pool with 3 connections per instance. Pooled connection string recommended.
- **OpenAI**: the only provider. One key covers every seeded model. Called with `fetch` from server code only;
  `lib/openai.ts` imports `server-only` so it can never ship to the browser.
- **Railway** (optional mirror): the same app runs with `npm run build && npm start`; `PORT` is respected.

## Fiscal Architecture

| Line | Number |
| --- | --- |
| Model spend per comparison | 2-3 calls x ~350 tokens in, <=400 out. At seeded rates this is well under $0.001. The `/pricing` page shows the measured average from `audit_events`. |
| Free tier | 3 comparisons per day per hashed IP, so worst case per heavy free user is a few cents per month. |
| Pro, $19/mo | 30/day cap, history, CSV. Even at the cap every day, model spend is under $1. Margin above 95%. |
| Team API, usage-based | Model cost passed through at the published rate plus a platform fee, so usage never runs at a loss. |
| Fixed cost | Vercel and Neon both scale to zero. No paid third-party services. |

Every call is logged in `audit_events` with model, tokens and estimated cost, so spend can be reconciled
against the OpenAI invoice. Prices carry an "as of" date and are never invented: a missing rate is stored as
null with `is_unknown = true` and shown as UNKNOWN.

## Governance

- **Secrets**: `OPENAI_API_KEY` and `DATABASE_URL` live only in server env (Vercel, Railway, local `.env`).
  Nothing in `NEXT_PUBLIC_*`. `.env` is git-ignored.
- **Data minimization**: the model sees a fixed fictional fixture plus the user's one-line task. No uploads.
  Model answers are shown to the user and not stored.
- **Privacy**: IPs are stored only as a salted SHA-256 hash for rate limiting.
- **Retention**: runs and audit events older than 14 days are deleted on each new run; rate-limit rows after
  2 days.
- **Spend control**: 3 runs per day per hashed IP (atomic upsert, so concurrent requests cannot overshoot),
  400 output token cap, 25s timeout per model, at most 3 calls per run.
- **Auditability**: one transaction writes `runs`, `run_results` and `audit_events` together.
- **Honest scoring**: failed answers have no cost per success; unknown prices cannot win a recommendation.

## Schema

See [`db/schema.sql`](db/schema.sql) and [`db/seed.sql`](db/seed.sql).

| Table | Purpose |
| --- | --- |
| `tools_seed` | Model slug, provider, model id, per-1M token prices, pricing URL, `last_checked`, `is_unknown` |
| `runs` | One comparison: current tool text, task, success criteria, recommended slug, hashed IP |
| `run_results` | One row per model: passed, quality band, estimated cost, cost per success, latency, error |
| `audit_events` | One row per completed model call: model, tokens in/out, estimated cost, success |
| `rate_limits` | Hashed IP, window start, count |

Seeded prices (USD per 1M tokens, standard tier, as of 2026-10-01, from https://openai.com/api/pricing/):

| Model | Input | Output |
| --- | --- | --- |
| gpt-4o-mini | 0.15 | 0.60 |
| gpt-4.1-mini | 0.40 | 1.60 |
| gpt-4.1-nano | 0.10 | 0.40 |

## Local run

```bash
npm install
cp .env.example .env        # fill DATABASE_URL and OPENAI_API_KEY
node --env-file=.env scripts/db-setup.mjs   # applies schema + seed (idempotent)
npm run dev                 # http://localhost:3000
npm run build && npm start  # production build
```

## Env vars

| Name | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Neon pooled connection string. `sslmode=require` is appended if missing. |
| `OPENAI_API_KEY` | yes | Server only. Never exposed to the client bundle. |
| `FREE_COMPARISONS_PER_DAY` | no | Defaults to 3. |
| `APP_URL` | no | Public URL of the deployment. |
| `IP_HASH_SALT` | no | Salt for the IP hash. Defaults to a fixed value. |

## Routes

- `/` comparison page
- `POST /api/run` body `{ statement, current, alternatives[], criteria: { wordCap } }`
- `GET /api/tools`
- `/health` returns `{ "ok": true }`
- `/pricing`, `/privacy`, `/terms`
