// The app's own per-user AI count (3 a day for the closed test). It resets at the SAME instant as the server's caps:
// the server's next_reset_at (RFC 3339, on every parse response / job poll), never a local midnight. Pure.

export interface AiQuota { used: number; /** the server's next_reset_at, as last seen */ resetAt?: string }
export const EMPTY_QUOTA: AiQuota = { used: 0 };
const ms = (iso?: string) => (iso ? new Date(iso).getTime() : NaN);

/** Past the known reset: the count starts again (and the next reset is unknown until the server says). */
export function rollQuota(q: AiQuota | undefined, now = Date.now()): AiQuota {
  const cur = q ?? EMPTY_QUOTA;
  const t = ms(cur.resetAt);
  return Number.isFinite(t) && now >= t ? { used: 0 } : cur;
}
/** A server response carried next_reset_at. A later instant than the one we had means the server's day already
 * rolled (e.g. the phone clock is behind): the count starts again too. Same object back when nothing changes. */
export function noteReset(q: AiQuota | undefined, iso: string, now = Date.now()): AiQuota {
  const t = ms(iso);
  if (!Number.isFinite(t)) return q ?? EMPTY_QUOTA;
  const cur = rollQuota(q, now);
  if (cur.resetAt === iso) return cur;
  const had = ms(cur.resetAt);
  return { used: Number.isFinite(had) && t > had ? 0 : cur.used, resetAt: iso };
}
/** One AI request made from this phone. */
export const countAi = (q: AiQuota | undefined, now = Date.now()): AiQuota => { const c = rollQuota(q, now); return { ...c, used: c.used + 1 }; };
/** The app's own cap applies only while the server's reset is known and still ahead; otherwise the server decides. */
export function localCapHit(q: AiQuota | undefined, cap: number, now = Date.now()): boolean {
  const c = rollQuota(q, now);
  const t = ms(c.resetAt);
  return Number.isFinite(t) && now < t && c.used >= cap;
}
