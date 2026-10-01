import { createHash } from "node:crypto";
import { db } from "./db";

export function freeLimit(): number {
  const n = Number(process.env.FREE_COMPARISONS_PER_DAY);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
}

export function clientIp(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return headers.get("x-real-ip") ?? "unknown";
}

export function hashIp(ip: string): string {
  const salt = process.env.IP_HASH_SALT ?? "realizah-v1";
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex");
}

// Rolling 24h window per hashed IP. Atomic upsert so concurrent requests
// cannot both slip under the cap.
export async function takeToken(
  ipHash: string
): Promise<{ allowed: boolean; count: number; limit: number; resetsAt: Date }> {
  const limit = freeLimit();
  const { rows } = await db().query<{ count: number; window_start: Date }>(
    `insert into rate_limits (id, window_start, count)
          values ($1, now(), 1)
     on conflict (id) do update set
       count = case when rate_limits.window_start < now() - interval '1 day'
                    then 1 else rate_limits.count + 1 end,
       window_start = case when rate_limits.window_start < now() - interval '1 day'
                           then now() else rate_limits.window_start end
     returning count, window_start`,
    [ipHash]
  );
  const { count, window_start } = rows[0];
  const resetsAt = new Date(new Date(window_start).getTime() + 24 * 60 * 60 * 1000);
  return { allowed: count <= limit, count, limit, resetsAt };
}
