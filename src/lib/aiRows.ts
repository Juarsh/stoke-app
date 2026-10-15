// AI rows on Log (design-notes "Estimating and failed estimate rows", Oct 15) + leaving Log with open items.
// Pure, so it is testable under Node.
import { DISH_TABLE_VERSION, Item, parser } from '../parser';
import { ParsePending } from './api';
import { FoodEntry, reviewEntry, Slot } from './domain';
import type { ParseResponse } from './parseLocal';
import type { PendingFood } from './syncQueue';

export type AiStatus = 'estimating' | 'failed' | 'ready';
/** A pending job is still estimating; a fallback error / busy / cap (or an answer with no items) is failed. */
export function aiStatus(r: ParseResponse | unknown): AiStatus {
  if (r instanceof ParsePending) return 'estimating';
  if (r instanceof Error || !r || typeof r !== 'object') return 'failed';
  const p = r as ParseResponse;
  if (['error', 'busy', 'cap_reached', 'not_configured'].includes(p.fallback)) return 'failed';
  return p.items?.some((i) => i.ai_estimate) ? 'ready' : 'failed';
}

/** Failed row: the user's own kcal. Counted only after they press Add on it. */
export type FailedRow = { key: string; id: string; name: string; kcal: string; protein: string; added: boolean };
export const failedCounts = (f: FailedRow) => f.added && Number(f.kcal) > 0;

/** Late AI answer for a span: fills the same row (same stable id) as an unconfirmed inline estimate.
 * Never auto-confirmed; dropped when the user already typed their own kcal on the failed row. */
export function lateAnswer(failed: FailedRow | undefined, items: Item[]): { drop: true } | { drop: false; items: Item[] } {
  if (failed && Number(failed.kcal) > 0) return { drop: true };
  return { drop: false, items: items.map((it) => ({ ...it, needs_confirmation: true })) };
}

/** Leaving Log with items still open: nothing is lost. Open items become needs_review entries (streak yes, calories no);
 * estimating spans are queued as pending (they become review items when the answer lands); unfilled failed rows
 * become review placeholders. Review entries never auto-count: only an explicit confirm counts them. */
export function leaveLog(o: { open: Item[]; failed: FailedRow[]; estimating: { id: string; span: string }[]; slot: Slot; text: string; date: string; newId: () => string; now?: Date }) {
  const base = { slot: o.slot, raw_text: o.text, local_date: o.date, tableVersion: DISH_TABLE_VERSION, now: o.now };
  const reviews: FoodEntry[] = [
    ...o.open.map((it) => reviewEntry({ ...it, needs_confirmation: true }, { ...base, id: o.newId() })),
    ...o.failed.filter((f) => !failedCounts(f)).map((f) => reviewEntry(parser.unknown(f.name), { ...base, id: f.id })),
  ];
  const pending: PendingFood[] = o.estimating.map((e) => ({ id: e.id, span: e.span, slot: o.slot, local_date: o.date, raw_text: o.text, at: 0 }));
  return { reviews, pending };
}
