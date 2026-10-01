import "server-only";
import { db } from "../db";
import type { RegistryModel } from "./types";

// Active models with their available access paths and the latest price for
// each. Read once per comparison; the result is what selection sees.
export async function loadRegistry(): Promise<RegistryModel[]> {
  const { rows } = await db().query<{ m: RegistryModel }>(
    `select json_build_object(
       'id', m.id, 'slug', m.slug, 'creator', m.creator, 'name', m.name,
       'inputModalities', m.input_modalities, 'outputModalities', m.output_modalities,
       'contextWindow', m.context_window, 'maxOutputTokens', m.max_output_tokens,
       'supportedParameters', m.supported_parameters,
       'capabilities', coalesce((select json_agg(c.capability order by c.capability) from model_capabilities c where c.model_id = m.id), '[]'::json),
       'releaseDate', m.release_date, 'status', m.status,
       'benchmarks', coalesce((
          select json_object_agg(b.metric, b.value) from (
            select distinct on (metric) metric, value from model_benchmarks
             where model_id = m.id and value is not null order by metric, observed_on desc) b), '{}'::json),
       'access', coalesce((
          select json_agg(json_build_object(
            'accessId', a.id, 'providerId', a.provider_id, 'externalModelId', a.external_model_id,
            'priceId', p.id, 'inputUsdPer1m', p.input_usd_per_1m, 'outputUsdPer1m', p.output_usd_per_1m,
            'requestUsd', coalesce(p.request_usd, 0), 'priceStatus', coalesce(p.price_status, 'unknown'),
            'priceObservedAt', p.observed_at))
            from model_provider_access a
            left join lateral (
              select * from model_prices mp where mp.access_id = a.id order by mp.observed_at desc limit 1) p on true
           where a.model_id = m.id and a.available), '[]'::json)
     ) as m
     from models m
     where m.status = 'active'`
  );
  return rows.map(({ m }) => ({
    ...m,
    access: m.access.map((a) => ({
      ...a,
      inputUsdPer1m: a.inputUsdPer1m === null ? null : Number(a.inputUsdPer1m),
      outputUsdPer1m: a.outputUsdPer1m === null ? null : Number(a.outputUsdPer1m),
      requestUsd: Number(a.requestUsd ?? 0),
    })),
    benchmarks: Object.fromEntries(Object.entries(m.benchmarks ?? {}).map(([k, v]) => [k, Number(v)])),
  }));
}

export async function registryStats(): Promise<{
  discoverable: number;
  byCreator: number;
  lastRefresh: { at: string | null; status: string } | null;
}> {
  const { rows } = await db().query<{ discoverable: string; creators: string; at: Date | null; status: string | null }>(
    `select (select count(*) from models where status = 'active') as discoverable,
            (select count(distinct creator) from models where status = 'active') as creators,
            r.finished_at as at, r.status
       from (select 1) one
       left join lateral (select finished_at, status from registry_refreshes
                           where status in ('ok','partial') order by started_at desc limit 1) r on true`
  );
  const r = rows[0];
  return {
    discoverable: Number(r.discoverable),
    byCreator: Number(r.creators),
    lastRefresh: r.status ? { at: r.at?.toISOString() ?? null, status: r.status } : null,
  };
}
