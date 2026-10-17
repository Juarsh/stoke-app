// Phone-side backstop for AI estimates (Product, Oct 17): the server keeps its retry queue in Postgres and gives up after
// 30 minutes, but if that ever fails (lost job, server asleep, phone offline) a row must not sit on "Estimating" forever.
// Any meal still estimating / pending AI whose job started more than 35 minutes ago becomes a failed AI row: it shows
// "Couldn’t estimate this. Add the calories yourself.", takes the user's typed kcal only, is never bulk-eligible, is refused
// by the store guard without real kcal, and is never counted as 0. A late server answer for it is ignored. Pure (testable).
import type { Item } from '../parser';
import { parser } from '../parser';
import { DISH_TABLE_VERSION } from '../parser';
import { FoodEntry, reviewEntry } from './domain';
import { enqueue, Op, PendingFood } from './syncQueue';

export const AI_BACKSTOP_MS = 35 * 60_000;
/** FailedRow.reason / FoodEntry.ai_fail_reason for a row the backstop converted (failedCopy: the generic failed copy). */
export const BACKSTOP_REASON = 'backstop';

const ms = (t: number | string | undefined | null): number => (typeof t === 'number' ? t : t ? new Date(t).getTime() : NaN);
/** Strictly more than 35 minutes since the job started. A missing / unreadable start never expires (stamp one first). */
export function backstopDue(startedAt: number | string | undefined | null, now = Date.now()): boolean {
  const t = ms(startedAt);
  return Number.isFinite(t) && t > 0 && now - t > AI_BACKSTOP_MS;
}

/** When the queued food's AI job started: its queued_at, else its placeholder entry's created_at. */
export function pendingStart(f: PendingFood, entries: FoodEntry[]): number | undefined {
  if (typeof f.queued_at === 'number' && f.queued_at > 0) return f.queued_at;
  const t = ms(entries.find((e) => e.id === f.id)?.created_at);
  return Number.isFinite(t) && t > 0 ? t : undefined;
}

/** Older stored queues have no queued_at: stamp one (placeholder created_at, else now) so the cutoff can be evaluated. */
export function stampPending(queue: Op[], entries: FoodEntry[], now = Date.now()): Op[] {
  let changed = false;
  const q = queue.map((o) => {
    if (o.kind !== 'pending' || (typeof o.food.queued_at === 'number' && o.food.queued_at > 0)) return o;
    changed = true;
    return { ...o, food: { ...o.food, queued_at: pendingStart(o.food, entries) ?? now } };
  });
  return changed ? q : queue;
}

/** The failed AI reading: no number at all (kcal 0 = placeholder, never shown, never counted), needs the user's kcal. */
export function failedAiItem(span: string): Item {
  const z = { low: 0, best: 0, high: 0 };
  return { ...parser.unknown(span), kcal: z, protein_g: z, carbs_g: 0, fat_g: 0, source_note: 'Couldn’t estimate this',
    ai_state: 'failed', needs_input: true } as unknown as Item;
}

/** The converted review row (same stable id as the pending placeholder): needs_review, typed kcal only. */
export function backstopEntry(f: PendingFood, ph?: FoodEntry, now = new Date()): FoodEntry {
  const e = reviewEntry(failedAiItem(f.span), { id: f.id, slot: f.slot, raw_text: f.raw_text, local_date: f.local_date, tableVersion: DISH_TABLE_VERSION, now });
  return { ...e, custom_name: f.span, span: f.span, pending: false, ai_expired: true, ai_fail_reason: BACKSTOP_REASON,
    created_at: ph?.created_at ?? e.created_at, updated_at: now.toISOString() };
}

/** Queued foods past the cutoff: placeholder -> failed AI review row, its pending op (the job poll) removed, the row synced
 * as needs_review. Returns the same arrays when nothing is due. */
export function expirePending(entries: FoodEntry[], queue: Op[], now = Date.now()): { entries: FoodEntry[]; queue: Op[]; converted: string[] } {
  const due = queue.flatMap((o) => (o.kind === 'pending' && backstopDue(pendingStart(o.food, entries), now) ? [o.food] : []));
  if (!due.length) return { entries, queue, converted: [] };
  let es = entries, q = queue;
  for (const f of due) {
    const ph = es.find((e) => e.id === f.id);
    if (ph && (ph.deleted_at || !ph.pending)) { q = q.filter((o) => !(o.kind === 'pending' && o.food.id === f.id)); continue; } // already resolved / removed
    const n = backstopEntry(f, ph, new Date(now));
    es = ph ? es.map((e) => (e.id === f.id ? n : e)) : [...es, n];
    q = enqueue(q.filter((o) => !(o.kind === 'pending' && o.food.id === f.id)), { kind: 'upsert', entry: n, tries: 0 });
  }
  return { entries: es, queue: q, converted: due.map((f) => f.id) };
}

/** Is this id (or a split `${id}-n` of it) a row the backstop already converted? */
export function isExpiredId(entries: FoodEntry[], id: string): boolean {
  return entries.some((e) => e.ai_expired && (e.id === id || id.startsWith(`${e.id}-`)));
}
/** A late server result for a converted job is ignored: never overwrites a row the user may already have filled. */
export function dropLate(entries: FoodEntry[], resolved: FoodEntry[]): FoodEntry[] {
  return resolved.filter((r) => !isExpiredId(entries, r.id));
}
/** Queue after a flush that raced the conversion: no pending poll and no late-result upsert for a converted id. */
export function dropLateOps(queue: Op[], entries: FoodEntry[]): Op[] {
  return queue.filter((o) => !(o.kind === 'pending' && isExpiredId(entries, o.food.id))
    && !(o.kind === 'upsert' && !o.entry.ai_expired && isExpiredId(entries, o.entry.id)));
}
