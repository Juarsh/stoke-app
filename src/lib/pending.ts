// Pending foods: added while the network/AI was unavailable. They are kept in
// the sync queue with NO numbers and filled in only when the server resolves them.
import { DISH_TABLE_VERSION } from '../parser';
import type { ParseResponse } from './parseLocal';
import { ApiError, ParsePending } from './api';
import { autoSavable, entryFromItem, FoodEntry, mergeEntries, reviewEntry } from './domain';
import type { Item } from '../parser';
import { isPlaceholder } from './itemKind';
import { enqueue, FINAL_FAIL_REASONS, Op, PendingFood } from './syncQueue';
import { aiStatus, failReason, isCapReason, resetOf } from './aiRows';
import { failedAiEntry } from './aiBackstop';

/** Entries for a resolved span, or null while it is still unknown (cap reached, AI off, placeholder only). Ids derive from the
 * pending id, so a retried resolve is idempotent on the server (client_id). */
export async function resolvePending(api: { parse(t: string, ai?: boolean): Promise<ParseResponse>; parseJob?(id: string): Promise<ParseResponse> },
  f: PendingFood): Promise<FoodEntry[] | null | { job_id: string }> {
  let r: ParseResponse;
  try { r = f.job_id && api.parseJob ? await api.parseJob(f.job_id) : await api.parse(f.span, true); }
  catch (e) {
    if (e instanceof ParsePending) return { job_id: e.jobId };
    // the server's job queue is in memory: 404/410 = job lost. Forget the job id, stay needs_review, parse again later.
    if (f.job_id && e instanceof ApiError && (e.status === 404 || e.status === 410)) return { job_id: '' };
    throw e;
  }
  const got = r.items.filter((it) => !isPlaceholder(it) && it.kcal.best > 0);
  // the daily cap ran out for a queued food: a failed row with the cap copy now (typed kcal only), not an endless 'pending'
  if (!got.length && aiStatus(r) === 'failed' && isCapReason(failReason(r))) return [failedAiEntry(f, failReason(r), undefined, new Date(), resetOf(r))];
  // the server's job ended for good without a number (backend 22a6a18: gave_up after AI_MAX_ATTEMPTS, or error): the failed
  // row "Couldn’t estimate this. Add the calories yourself." now, not 'Estimating' until the 35-minute backstop
  const fin = finalReason(r);
  if (!got.length && aiStatus(r) === 'failed' && fin) return [failedAiEntry(f, fin, undefined, new Date())];
  if (!got.length) return null;
  // only a confident table match is saved; anything uncertain becomes a 'needs review' entry (no unwarned number)
  return got.map((it, i) => {
    const o = { id: i === 0 ? f.id : `${f.id}-${i}`, slot: f.slot, raw_text: f.raw_text, local_date: f.local_date, tableVersion: DISH_TABLE_VERSION };
    const e = autoSavable(it) ? entryFromItem(it, o) : reviewEntry(it, o);
    return f.job_id ? { ...e, job_id: f.job_id } : e;
  });
}

export { FINAL_FAIL_REASONS };
export function finalReason(r: { fallback_reason?: string; fallback?: string }): string | null {
  const x = r.fallback_reason || (FINAL_FAIL_REASONS.includes(r.fallback ?? '') ? r.fallback! : '');
  return FINAL_FAIL_REASONS.includes(x) ? x : null;
}

/** Late AI answer for a food already handed to the queue (Add tapped while estimating, or the 10 s timeout).
 * Keyed by the stable pending id: fills the pending placeholder in as UNCONFIRMED review entries; never confirms,
 * never touches an entry that is already resolved/saved, never duplicates. Pure. */
export function fillPending(entries: FoodEntry[], queue: Op[], id: string, items: Item[]): { entries: FoodEntry[]; queue: Op[]; changed: boolean } {
  const ph = entries.find((e) => e.id === id);
  if (!ph || !ph.pending || ph.deleted_at || ph.ai_expired) return { entries, queue, changed: false };
  const got = items.filter((it) => !isPlaceholder(it) && it.kcal.best > 0);
  if (!got.length) return { entries, queue, changed: false };
  const o = (i: number) => ({ id: i === 0 ? id : `${id}-${i}`, slot: ph.slot, raw_text: ph.raw_text, local_date: ph.local_date, tableVersion: DISH_TABLE_VERSION });
  const rv = got.map((it, i) => reviewEntry(it, o(i)));
  let q = queue.filter((op) => !(op.kind === 'pending' && op.food.id === id));
  for (const e of rv) q = enqueue(q, { kind: 'upsert', entry: e, tries: 0 });
  return { entries: mergeEntries(entries, rv), queue: q, changed: true };
}

/** One batched AI answer -> items per span (by matched_text; a single span takes everything). */
export function splitBySpan(got: Item[], spans: string[]): Item[][] {
  return spans.map((u) => {
    const mine = got.filter((g) => g.matched_text === u || u.includes(g.matched_text) || g.matched_text.includes(u));
    return mine.length ? mine : spans.length === 1 ? got : [];
  });
}
