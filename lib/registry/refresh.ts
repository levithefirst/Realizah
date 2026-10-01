// Daily model-market refresh. Each source is independent: a failing source
// is recorded and skipped, and whatever it last wrote stays usable. Nothing
// is deleted; models and access paths not seen this time are marked stale.
import "server-only";
import { createHash } from "node:crypto";
import { db } from "../db";
import { deriveCapabilities } from "./capabilities";
import { fetchOpenRouterCatalog, normalizeOpenRouterCatalog, type OpenRouterCatalogModel } from "./sources/openrouter";
import { fetchOpenAIModelIds, linkOpenAIDirect } from "./sources/openaiDirect";
import { fetchArtificialAnalysis, normalizeArtificialAnalysis } from "./sources/artificialAnalysis";
import type { NormalizedAccess, NormalizedPrice } from "./types";

type SourceReport = { status: "ok" | "skipped" | "error"; detail?: string; count?: number };

export type RefreshReport = {
  refreshId: string;
  status: "ok" | "partial" | "error";
  sources: Record<string, SourceReport>;
  modelsSeen: number;
  modelsNew: number;
  pricesChanged: number;
  markedStale: number;
};

function hash(v: unknown): string {
  return createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 32);
}

async function upsertAccess(rows: NormalizedAccess[]) {
  if (!rows.length) return;
  await db().query(
    `insert into model_provider_access (model_id, provider_id, external_model_id, source, available, last_seen_at, verified_at)
     select m.id, x.provider_id, x.external_model_id, x.source, true, now(), now()
       from jsonb_to_recordset($1::jsonb) as x(model_slug text, provider_id text, external_model_id text, source text)
       join models m on m.slug = x.model_slug
     on conflict (provider_id, external_model_id) do update set
       model_id = excluded.model_id, available = true, last_seen_at = now(), verified_at = now()`,
    [JSON.stringify(rows.map((a) => ({ model_slug: a.modelSlug, provider_id: a.providerId, external_model_id: a.externalModelId, source: a.source })))]
  );
}

// Inserts a price row only when it differs from the latest one for that
// access path, so model_prices is a history of changes.
async function insertChangedPrices(rows: NormalizedPrice[], refreshId: string): Promise<number> {
  if (!rows.length) return 0;
  const { rowCount } = await db().query(
    `with incoming as (
       select * from jsonb_to_recordset($1::jsonb) as x(
         provider_id text, external_model_id text, input numeric, output numeric, request numeric,
         status text, methodology text, source text, source_url text)
     ), acc as (
       select a.id as access_id, i.* from incoming i
         join model_provider_access a on a.provider_id = i.provider_id and a.external_model_id = i.external_model_id
     ), latest as (
       select distinct on (access_id) access_id, input_usd_per_1m, output_usd_per_1m, request_usd, price_status
         from model_prices order by access_id, observed_at desc
     )
     insert into model_prices (access_id, input_usd_per_1m, output_usd_per_1m, request_usd, price_status, methodology, source, source_url, refresh_id)
     select acc.access_id, acc.input, acc.output, coalesce(acc.request, 0), acc.status, acc.methodology, acc.source, acc.source_url, $2
       from acc left join latest l on l.access_id = acc.access_id
      where l.access_id is null
         or l.input_usd_per_1m is distinct from acc.input
         or l.output_usd_per_1m is distinct from acc.output
         or l.request_usd is distinct from coalesce(acc.request, 0)
         or l.price_status is distinct from acc.status`,
    [
      JSON.stringify(
        rows.map((p) => ({
          provider_id: p.providerId,
          external_model_id: p.externalModelId,
          input: p.inputUsdPer1m,
          output: p.outputUsdPer1m,
          request: p.requestUsd,
          status: p.status,
          methodology: p.methodology,
          source: p.source,
          source_url: p.sourceUrl,
        }))
      ),
      refreshId,
    ]
  );
  return rowCount ?? 0;
}

async function markStale(providerId: string, since: Date): Promise<number> {
  await db().query(
    `update model_provider_access set available = false
      where provider_id = $1 and available and last_seen_at < $2`,
    [providerId, since]
  );
  const { rowCount } = await db().query(
    `update models m set status = 'stale'
      where status = 'active'
        and not exists (select 1 from model_provider_access a where a.model_id = m.id and a.available)`
  );
  return rowCount ?? 0;
}

async function refreshOpenRouter(refreshId: string, started: Date, fetchImpl: typeof fetch) {
  const raw: OpenRouterCatalogModel[] = await fetchOpenRouterCatalog(fetchImpl);
  const { models, access, prices } = normalizeOpenRouterCatalog(raw);

  const upsert = await db().query<{ inserted: boolean }>(
    `insert into models (slug, creator, name, description, input_modalities, output_modalities, context_window,
                         max_output_tokens, supported_parameters, release_date, knowledge_cutoff, expiration_date,
                         status, source, source_url, last_seen_at, verified_at)
     select slug, creator, name, description, input_modalities, output_modalities, context_window,
            max_output_tokens, supported_parameters, release_date, knowledge_cutoff, expiration_date,
            'active', source, source_url, now(), now()
       from jsonb_to_recordset($1::jsonb) as x(
         slug text, creator text, name text, description text, input_modalities text[], output_modalities text[],
         context_window integer, max_output_tokens integer, supported_parameters text[], release_date date,
         knowledge_cutoff date, expiration_date date, source text, source_url text)
     on conflict (slug) do update set
       creator = excluded.creator, name = excluded.name, description = excluded.description,
       input_modalities = excluded.input_modalities, output_modalities = excluded.output_modalities,
       context_window = excluded.context_window, max_output_tokens = excluded.max_output_tokens,
       supported_parameters = excluded.supported_parameters, release_date = excluded.release_date,
       knowledge_cutoff = excluded.knowledge_cutoff, expiration_date = excluded.expiration_date,
       status = case when models.status = 'deprecated' then 'deprecated' else 'active' end,
       source = excluded.source, source_url = excluded.source_url, last_seen_at = now(), verified_at = now()
     returning (xmax = 0) as inserted`,
    [
      JSON.stringify(
        models.map((m) => ({
          slug: m.slug,
          creator: m.creator,
          name: m.name,
          description: m.description,
          input_modalities: m.inputModalities,
          output_modalities: m.outputModalities,
          context_window: m.contextWindow,
          max_output_tokens: m.maxOutputTokens,
          supported_parameters: m.supportedParameters,
          release_date: m.releaseDate,
          knowledge_cutoff: m.knowledgeCutoff,
          expiration_date: m.expirationDate,
          source: m.source,
          source_url: m.sourceUrl,
        }))
      ),
    ]
  );
  const modelsNew = upsert.rows.filter((r) => r.inserted).length;

  await upsertAccess(access);
  const pricesChanged = await insertChangedPrices(prices, refreshId);

  // Capabilities are current state; history lives in model_snapshots.
  const caps = models.map((m) => ({ slug: m.slug, caps: deriveCapabilities(m) }));
  await db().query(
    `with incoming as (
       select x.slug, c.cap from jsonb_to_recordset($1::jsonb) as x(slug text, caps text[]), unnest(x.caps) as c(cap)
     ), del as (
       delete from model_capabilities mc using models m
        where mc.model_id = m.id and mc.source = 'openrouter_catalog'
          and m.slug in (select x.slug from jsonb_to_recordset($1::jsonb) as x(slug text, caps text[]))
          and not exists (select 1 from incoming i where i.slug = m.slug and i.cap = mc.capability)
     )
     insert into model_capabilities (model_id, capability, source, verified_at)
     select m.id, i.cap, 'openrouter_catalog', now() from incoming i join models m on m.slug = i.slug
     on conflict (model_id, capability) do update set verified_at = now(), source = excluded.source`,
    [JSON.stringify(caps)]
  );

  await db().query(
    `insert into model_snapshots (refresh_id, source, source_key, payload_hash, payload)
     select $2, 'openrouter_catalog', x.key, x.hash, x.payload
       from jsonb_to_recordset($1::jsonb) as x(key text, hash text, payload jsonb)
     on conflict (source, source_key, payload_hash) do nothing`,
    [JSON.stringify(raw.map((r) => ({ key: r.id, hash: hash(r), payload: r }))), refreshId]
  );

  const marked = await markStale("openrouter", started);
  return {
    count: raw.length,
    modelsSeen: models.length,
    modelsNew,
    pricesChanged,
    marked,
    orPrices: new Map(
      prices.filter((p) => !p.externalModelId.endsWith(":free")).map((p) => [p.externalModelId, { input: p.inputUsdPer1m, output: p.outputUsdPer1m }])
    ),
  };
}

export async function refreshRegistry(opts: { fetchImpl?: typeof fetch } = {}): Promise<RefreshReport> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const started = new Date();
  const {
    rows: [{ id: refreshId }],
  } = await db().query<{ id: string }>(`insert into registry_refreshes default values returning id`);
  const sources: Record<string, SourceReport> = {};
  let modelsSeen = 0,
    modelsNew = 0,
    pricesChanged = 0,
    markedStale = 0;
  let orPrices = new Map<string, { input: number | null; output: number | null }>();

  try {
    const r = await refreshOpenRouter(refreshId, started, fetchImpl);
    sources.openrouter_catalog = { status: "ok", count: r.count };
    modelsSeen += r.modelsSeen;
    modelsNew += r.modelsNew;
    pricesChanged += r.pricesChanged;
    markedStale += r.marked;
    orPrices = r.orPrices;
  } catch (e) {
    sources.openrouter_catalog = { status: "error", detail: (e as Error).message.slice(0, 300) };
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    sources.openai_models_api = { status: "skipped", detail: "OPENAI_API_KEY not set" };
  } else {
    try {
      const ids = await fetchOpenAIModelIds(openaiKey, fetchImpl);
      const { rows: slugRows } = await db().query<{ slug: string }>(`select slug from models where creator = 'openai'`);
      const { rows: verified } = await db().query<{ model_id: string; i: string; o: string; url: string }>(
        `select model_id, input_usd_per_1m as i, output_usd_per_1m as o, pricing_url as url
           from tools_seed where provider = 'openai' and not is_unknown
            and input_usd_per_1m is not null and output_usd_per_1m is not null`
      );
      const linked = linkOpenAIDirect({
        directIds: ids,
        registrySlugs: new Set(slugRows.map((r) => r.slug)),
        verifiedPrices: verified.map((v) => ({ modelId: v.model_id, input: Number(v.i), output: Number(v.o), sourceUrl: v.url })),
        openrouterPrices: orPrices,
      });
      await upsertAccess(linked.access);
      pricesChanged += await insertChangedPrices(linked.prices, refreshId);
      markedStale += await markStale("openai", started);
      sources.openai_models_api = { status: "ok", count: linked.access.length };
    } catch (e) {
      sources.openai_models_api = { status: "error", detail: (e as Error).message.slice(0, 300) };
    }
  }

  const aaKey = process.env.ARTIFICIAL_ANALYSIS_API_KEY;
  if (!aaKey) {
    sources.artificial_analysis = { status: "skipped", detail: "ARTIFICIAL_ANALYSIS_API_KEY not set" };
  } else {
    try {
      const rows = await fetchArtificialAnalysis(aaKey, fetchImpl);
      const { rows: slugRows } = await db().query<{ slug: string }>(`select slug from models`);
      const benches = normalizeArtificialAnalysis(rows, slugRows.map((r) => r.slug));
      await db().query(
        `insert into model_benchmarks (model_id, source, source_model_slug, source_model_name, source_creator, metric, value)
         select m.id, x.source, x.source_model_slug, x.source_model_name, x.source_creator, x.metric, x.value
           from jsonb_to_recordset($1::jsonb) as x(model_slug text, source text, source_model_slug text,
                source_model_name text, source_creator text, metric text, value numeric)
           left join models m on m.slug = x.model_slug
         on conflict (source, source_model_slug, metric, observed_on) do update set
           value = excluded.value, model_id = excluded.model_id`,
        [
          JSON.stringify(
            benches.map((b) => ({
              model_slug: b.modelSlug,
              source: b.source,
              source_model_slug: b.sourceModelSlug,
              source_model_name: b.sourceModelName,
              source_creator: b.sourceCreator,
              metric: b.metric,
              value: b.value,
            }))
          ),
        ]
      );
      sources.artificial_analysis = {
        status: "ok",
        count: rows.length,
        detail: `${new Set(benches.filter((b) => b.modelSlug).map((b) => b.modelSlug)).size} linked to registry models`,
      };
    } catch (e) {
      sources.artificial_analysis = { status: "error", detail: (e as Error).message.slice(0, 300) };
    }
  }

  const statuses = Object.values(sources).map((s) => s.status);
  const status: RefreshReport["status"] =
    sources.openrouter_catalog.status === "error" ? (statuses.includes("ok") ? "partial" : "error") : statuses.includes("error") ? "partial" : "ok";

  await db().query(
    `update registry_refreshes set finished_at = now(), status = $2, sources = $3, models_seen = $4,
            models_new = $5, prices_changed = $6, marked_stale = $7,
            error = $8
      where id = $1`,
    [
      refreshId,
      status,
      JSON.stringify(sources),
      modelsSeen,
      modelsNew,
      pricesChanged,
      markedStale,
      status === "ok" ? null : Object.entries(sources).filter(([, s]) => s.status === "error").map(([k, s]) => `${k}: ${s.detail}`).join("; "),
    ]
  );
  return { refreshId, status, sources, modelsSeen, modelsNew, pricesChanged, markedStale };
}

export async function lastRefresh(): Promise<{ id: string; finishedAt: string | null; status: string } | null> {
  const { rows } = await db().query<{ id: string; finished_at: Date | null; status: string }>(
    `select id, finished_at, status from registry_refreshes
      where status in ('ok', 'partial') order by started_at desc limit 1`
  );
  return rows[0] ? { id: rows[0].id, finishedAt: rows[0].finished_at?.toISOString() ?? null, status: rows[0].status } : null;
}
