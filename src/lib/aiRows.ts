// AI rows on Log (design-notes "Estimating and failed estimate rows", Oct 15) + leaving Log with open items.
// Pure, so it is testable under Node.
import { DISH_TABLE_VERSION, Item, parser } from '../parser';
import { ParsePending } from './api';
import { FoodEntry, reviewEntry, Slot } from './domain';
import type { ParseResponse } from './parseLocal';
import type { PendingFood } from './syncQueue';

export type AiStatus = 'estimating' | 'failed' | 'ready';
/** The server's ai_state (API.md @ a72964e) decides the row. A pending job poll (ParsePending) is still estimating.
 * Only daily_limit / user_limit / error end as failed; rate_limited / unavailable / timeout stay estimating (the server requeues). */
export function aiStatus(r: ParseResponse | unknown): AiStatus {
  if (r instanceof ParsePending) return 'estimating';
  if (r instanceof Error || !r || typeof r !== 'object') return 'failed';
  const p = r as ParseResponse;
  if (p.ai_state === 'estimating') return 'estimating';
  if (p.ai_state === 'failed') return 'failed';
  if (p.ai_state === 'answered') return p.items?.some((i) => i.ai_estimate) ? 'ready' : 'failed';
  // answers from a server without ai_state (mock / offline): the old fallback mapping
  if (['rate_limited', 'unavailable', 'timeout'].includes(p.fallback_reason ?? '') || (!p.fallback_reason && p.fallback === 'rate_limited')) return 'estimating';
  if (['error', 'busy', 'cap_reached', 'global_cap_reached', 'daily_limit', 'not_configured'].includes(p.fallback)) return 'failed';
  return p.items?.some((i) => i.ai_estimate) ? 'ready' : 'failed';
}

/** How long to wait before the next poll of a job that is still estimating. next_attempt_at (RFC 3339) is a hint:
 * wait until then, clamped so a far-off hint never stalls the row and a past one still backs off a little. */
export function pollDelay(nextAttemptAt?: string, now = Date.now()): number {
  const MIN = 2000, MAX = 30000;
  const t = nextAttemptAt ? new Date(nextAttemptAt).getTime() : NaN;
  if (isNaN(t)) return MIN;
  return Math.min(MAX, Math.max(MIN, t - now));
}

/** Failed row: the user's own kcal. Counted only after they press Add on it. */
export type FailedRow = { key: string; id: string; name: string; kcal: string; protein: string; added: boolean; reason?: string; userDailyLimit?: number; resetsAt?: string };

/** A failed meal (ai_state "failed"): the spans the user has to type calories for. failed_spans when the server
 * sends them, else custom_items flagged needs_input, else the spans we asked about. Never carries a kcal. */
export function failedSpans(r: ParseResponse, asked: string[]): string[] {
  const named = (r.failed_spans ?? []).map((s) => s.text).filter((t) => t.trim());
  if (named.length) return named;
  const custom = (r.custom_items ?? []).filter((c) => c.needs_input).map((c) => c.custom_name).filter((t) => t.trim());
  return custom.length ? custom : asked;
}
/** Failed rows to show for a failed meal: every span we asked about, plus any other open span the server listed. */
export function failedRows(r: ParseResponse, asked: string[]): string[] {
  const extra = failedSpans(r, asked).filter((t) => !asked.some((a) => a === t || a.includes(t) || t.includes(a)));
  return [...asked, ...extra];
}
/** Failed-row copy by the server's fallback_reason (user_daily_limit from the server; left out when missing). */
/** ai_resets_at (RFC 3339) in the user's local time, e.g. "12:30 PM"; '' when missing or unreadable. */
export function resetTime(iso?: string): string {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d.getTime())) return '';
  const h = d.getHours(), m = d.getMinutes();
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
export function failedCopy(f: Pick<FailedRow, 'reason' | 'userDailyLimit' | 'resetsAt'>): string {
  const time = resetTime(f.resetsAt);
  if (f.reason === 'user_limit') return `You’ve used today’s ${f.userDailyLimit ? `${f.userDailyLimit} ` : ''}AI estimates. Add the calories yourself${time ? `, or try again after ${time}` : ''}.`;
  if (f.reason === 'daily_limit') return time ? `AI estimates are used up until ${time}. Add the calories yourself.` : 'AI estimates are used up for now. Add the calories yourself.';
  return 'Couldn’t estimate this. Add the calories yourself.';
}
/** failed rows still waiting for the user's kcal (they count as "still needs a choice") */
export const failedWaiting = (fs: FailedRow[]) => fs.filter((f) => !failedCounts(f)).length;
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
