// Offline-first sync queue. Ops are persisted and replayed in order; the payload
// is the entry snapshot, so syncing never recalculates numbers.
// Offline / server errors (no status, 5xx): the op stays at the head with tries+1 and a backoff (5 s doubling,
// max 30 min). A 409 never blocks the queue: a version conflict is resolved in the API (the user's edit re-applied
// on the server's version, retried once); what still can't be applied (409, other 4xx, or a 409 keep-and-retry
// after MAX_TRIES) is surfaced on its entry ("Couldn’t sync this. Tap to retry") and later ops keep flowing.
import type { FoodEntry, Slot } from './domain';
import type { ServerRow } from './api';

/** A food the user added while its numbers were still unknown (network / AI). Never saved with a number. */
export interface PendingFood { id: string; span: string; slot: Slot; local_date: string; raw_text: string; job_id?: string; /** ms when queued (0 = straight to items to review) */ at?: number;
  /** ms when its AI job started (Log estimate start, else when queued): the 35-minute backstop (aiBackstop) runs from here */ queued_at?: number;
  /** rg8 B2: the amount the phone read in `span` (which carries its amount words): a table answer that differs is saved for review */ amount?: { qty: number; unit: string } }
/** fives: consecutive 5xx answers for this op (rg7 H1: 3 in a row -> flagged on the row, off the queue head) */
type Retry = { tries: number; nextAt?: number; fives?: number;
  /** the wait is for no connection (or a wait the server asked for), not a 5xx: everything behind it waits too (rg8 B3) */ net?: boolean;
  /** next build (rg10 T2): the phone's own retry of a 5xx-flagged row (queueAutoRetry), not a user action */ auto?: boolean };
export type Op =
  | ({ kind: 'upsert'; entry: FoodEntry } & Retry)
  /** edited: the row had an edit the server never got (FoodEntry.unsynced_edit): a refusal fetches the server's copy */
  | ({ kind: 'delete'; id: string; edited?: boolean } & Retry)
  | ({ kind: 'pending'; food: PendingFood } & Retry)
  | ({ kind: 'forget'; id: number } & Retry)
  | ({ kind: 'forgetAll'; id: 'all' } & Retry)
  /** the 35-minute backstop gave up on this parse job: POST /v1/parse/jobs/{id}/abandon (queued offline, sent when online) */
  | ({ kind: 'abandon'; id: string } & Retry)
  /** onboarding profile: queued even before sign-in, sent once signed in (ProfilePayload: on-device-only fields excluded) */
  | ({ kind: 'profile'; id: 'profile'; payload: import('./domain').ProfilePayload } & Retry);
export interface Sender {
  /** returns the server's row version for the entry, when the server sent one */
  upsertEntry(e: FoodEntry): Promise<void | { version?: number; row?: ServerRow }>; deleteEntry(id: string): Promise<void>;
  /** GET /v1/entries/{id}: the server's copy of a row, null on 404 (next build: a refused delete of an edited row) */
  getEntry?(id: string): Promise<ServerRow | null>;
  /** Resolve a pending food into entries, or null if still unknown (stays queued). */
  /** entries, null (still unknown) or { job_id } (server is working on it: poll that job next time) */
  resolvePending(f: PendingFood): Promise<FoodEntry[] | null | { job_id: string }>;
  deleteRemembered(id?: number): Promise<void>;
  putProfile?(p: import('./domain').ProfilePayload): Promise<void>;
  /** POST /v1/parse/jobs/{id}/abandon; 404/410 count as done */
  abandonJob?(jobId: string): Promise<void>;
}

/** Final, non-cap AI endings the server names (fallback_reason, else fallback): the job will never answer (backend 22a6a18). */
export const FINAL_FAIL_REASONS = ['gave_up', 'error'];
const opId = (o: Op) => (o.kind === 'upsert' ? o.entry.id : o.kind === 'pending' ? `pending:${o.food.id}` : `${o.kind}:${o.id}`);

/** Coalesce: a newer op for the same id replaces older queued ops. */
export function enqueue(q: Op[], op: Op): Op[] {
  const id = op.kind === 'delete' ? op.id : opId(op);
  return [...q.filter((o) => (o.kind === 'delete' ? o.id : opId(o)) !== id), op];
}

/** Reopened in Review (not flagged): 409 job_abandoned, a refused profile, or a 400/422 CHOICE_CODES pick on the POST of a
 * new confirmed row. Every other 4xx on an upsert is isRefusal (flagged, value kept). */
/** The server asks the user to pick (variant / amount) and says which: the one 4xx on a NEW confirmed row that goes back to
 * Review with its choices (the app only confirms after a pick, so this is an old-build / table-drift case). */
export const CHOICE_CODES = ['variant_required', 'quantity_required'];
/** the row's line for a pick the server asks for (PE, rg6 F4) */
export const choiceCopy = (code: string) => (code === 'quantity_required' ? 'Pick how much to save this.' : 'Pick a type to save this.');
export const isRejection = (e: unknown, op: Op) => isAbandonedSave(e, op) || ((op.kind === 'profile'
  || (op.kind === 'upsert' && !op.entry.pending && !op.entry.needs_review && (e as { patch?: unknown })?.patch !== true && CHOICE_CODES.includes(codeOf(e))))
  && typeof (e as { status?: unknown })?.status === 'number' && [400, 422].includes((e as { status: number }).status));
/** 409 job_abandoned: an AI reading saved with an abandoned job's id is refused for good (the user's typed kcal is what counts). */
export const isAbandonedSave = (e: unknown, op: Op) => op.kind === 'upsert' && (e as { status?: unknown })?.status === 409 && codeOf(e) === 'job_abandoned';
const codeOf = (e: unknown) => { const c = (e as { code?: unknown })?.code; return typeof c === 'string' ? c : ''; };

const reasonOf = (e: unknown) => { const r = (e as { reason?: unknown })?.reason; return typeof r === 'string' && r ? r : undefined; };
/** A 4xx on an upsert's PATCH, other than 404 (delete wins), 409 (version / abandon) and the retryable 401/408/429. */
export const isPatchRefusal = (e: unknown) => (e as { patch?: unknown })?.patch === true && isRefusalStatus(statusOf(e));
/** Hard-gate rule (rg5 G2/G1): any 4xx on an upsert, POST (a new row, a review-later draft) or PATCH, other than 404 / 409 /
 * the retryable 401/408/429 and the CHOICE_CODES pick: the phone keeps the user's row and value, shows
 * "Couldn’t sync this. Tap to retry" with the server's reason; never a 0-kcal Review row, never an undone Add. */
export const isRefusal = (e: unknown, op: Op) => op.kind === 'upsert' && isRefusalStatus(statusOf(e)) && !isRejection(e, op);
const isRefusalStatus = (s: number) => s >= 400 && s < 500 && ![401, 404, 408, 409, 429].includes(s);
const statusOf = (e: unknown) => { const s = (e as { status?: unknown })?.status; return typeof s === 'number' ? s : 0; };
/** Tries before a 409 that asks to keep-and-retry (e.g. an unknown dish table version) is surfaced instead. */
export const MAX_TRIES = 5;
/** An entry op that can't be applied: surfaced on the entry, removed from the queue, never blocks later ops.
 * Offline (no status) and 5xx keep the backoff retry. */
export function isStuck(e: unknown, op: Op, tries: number): boolean {
  if (op.kind !== 'upsert' && op.kind !== 'delete') return false;
  const s = statusOf(e);
  if (s === 409) return codeOf(e) === 'unknown_dish_table_version' ? tries >= MAX_TRIES : true;
  return s >= 400 && s < 500 && s !== 401 && s !== 408 && s !== 429;
}

/** rg7 H1: an entry save the server answered 5xx this many times in a row is flagged on its row ("Couldn’t sync this. Tap
 * to retry", tapping retries) and leaves the queue head so later ops proceed; a delete goes to the back of the queue. */
export const MAX_FIVES = 3;
export const SERVER_ERROR = 'server_error';
/** would flush send anything now? (same skipping rules as flush; the store never flushes a queue with nothing due) */
export function hasDue(q: Op[], now = Date.now()): boolean {
  const parked = new Set<string>();
  for (const op of q) {
    const k = opKey(op);
    if (parked.has(k)) continue;
    if (op.nextAt && op.nextAt > now) { if (op.net) return false; parked.add(k); continue; }
    return true;
  }
  return false;
}
/** when the next op's wait is over (the store's wake-up timer) */
export const nextDueAt = (q: Op[]): number | undefined => { const ts = q.flatMap((o) => (o.nextAt ? [o.nextAt] : [])); return ts.length ? Math.min(...ts) : undefined; };
/** a delete the server answered 5xx three times: the row is flagged and says the server still has it (rg8 B3) */
export const NOT_DELETED_REASON = 'Not deleted on the server yet.';
/** ordering key: ops on one id stay in order; ops on other ids never wait behind a parked one (rg8 B3) */
export const opKey = (o: Op): string => (o.kind === 'upsert' ? `e:${o.entry.id}` : o.kind === 'delete' ? `e:${o.id}` : o.kind === 'pending' ? `e:${o.food.id}`
  : o.kind === 'forget' || o.kind === 'forgetAll' ? 'forget' : o.kind === 'profile' ? 'profile' : `${o.kind}:${(o as { id?: unknown }).id ?? ''}`);
export const backoffMs = (tries: number) => Math.min(30 * 60_000, 5_000 * 2 ** Math.max(0, tries - 1));

/** Sends ops in order per id: a parked (5xx / backing-off) op holds back only its own id; no connection stops the flush. Returns the remaining queue and entries resolved from pending foods. */
export type FlushResult = { rest: Op[]; resolved: FoodEntry[]; rejected: { entry: FoodEntry; code: string; variant_options?: FoodEntry['variant_options'] }[]; profileRejected?: string;
  /** entry id -> the server's row version after this flush */
  versions: Record<string, number>;
  /** entry ops that could not be applied (surfaced on the entry); `sent` is the op's entry snapshot (undefined for a delete) */
  failed: { id: string; code: string; sent?: FoodEntry; reason?: string; options?: FoodEntry['variant_options'] }[];
  /** entry id -> the server's copy of the row this flush saved, and the snapshot that was sent (rg6 F1: a row the server
   * stored differently, e.g. needs_review for a unit the dish doesn't come in, is shown as the server has it) */
  rows?: Record<string, { row: ServerRow; sent: FoodEntry }>;
  /** entries whose PATCH got 404: deleted on the server (another device). The delete wins: the phone drops them. */
  gone?: string[];
  /** rg10: deletes the server refused with a 4xx other than 404 (403, 400, 409, 410, 422, …): the row stays on the server, so
   * the phone restores it, counted as the server has it, with the server's reason. `row` is the server's copy when it sent one. */
  kept?: { id: string; code: string; reason?: string; row?: ServerRow; /** the delete replaced an edit the server never got */ edited?: boolean }[];
  /** CEO (next build): edits sent with a version the server's row has moved on from (409 version_conflict with its locked row,
   * or a version-less row whose copy changed): never re-applied; the phone takes `row` and says the edit wasn't saved */
  stale?: { id: string; row: ServerRow; sent: FoodEntry }[] };
/** a 409 version_conflict carrying the server's row, on an edit */
export const isStaleEdit = (e: unknown, op: Op) => op.kind === 'upsert' && statusOf(e) === 409 && codeOf(e) === 'version_conflict'
  && !!(e as { entry?: unknown })?.entry && typeof (e as { entry?: unknown }).entry === 'object';
export async function flush(q: Op[], s: Sender, now = Date.now()): Promise<FlushResult> {
  const rest = [...q];
  const versions: Record<string, number> = {};
  const rows: NonNullable<FlushResult['rows']> = {};
  const failed: FlushResult['failed'] = [];
  const gone: string[] = [];
  const resolved: FoodEntry[] = [];
  const rejected: { entry: FoodEntry; code: string; variant_options?: FoodEntry['variant_options'] }[] = [];
  let profileRejected: string | undefined;
  // rg8 B3: an op the server keeps answering 5xx is parked (backoff) and only the ops on the SAME id wait behind it, so
  // per-id order holds while rows on other ids still reach the server in this flush. No connection at all still stops.
  const parked = new Set<string>();
  const kept: NonNullable<FlushResult['kept']> = [];
  const stale: NonNullable<FlushResult['stale']> = [];
  /** delete ids already retried once after a 409 (their server copy, when the 409 carried one) */
  const conflicted = new Map<string, { row?: ServerRow; reason?: string }>();
  let i = 0;
  while (i < rest.length) {
    const op = rest[i];
    const k = opKey(op);
    if (parked.has(k)) { i++; continue; }
    if (op.nextAt && op.nextAt > now) { if (op.net) break; parked.add(k); i++; continue; } // a 5xx backing off: later ops on other ids go on
    try {
      if (op.kind === 'upsert') {
        const known = versions[op.entry.id] ?? op.entry.server_version;
        const r = await s.upsertEntry(known === op.entry.server_version ? op.entry : { ...op.entry, server_version: known });
        if (r && typeof r.version === 'number') versions[op.entry.id] = r.version;
        if (r && r.row) rows[op.entry.id] = { row: r.row, sent: op.entry };
      }
      else if (op.kind === 'delete') await s.deleteEntry(op.id);
      else if (op.kind === 'forget') await s.deleteRemembered(op.id);
      else if (op.kind === 'forgetAll') await s.deleteRemembered();
      else if (op.kind === 'profile') { if (s.putProfile) await s.putProfile(op.payload); }
      else if (op.kind === 'abandon') { if (s.abandonJob) await s.abandonJob(op.id); }
      else {
        const es = await s.resolvePending(op.food);
        if (es && 'job_id' in es) { rest[i] = { ...op, food: { ...op.food, job_id: es.job_id || undefined } }; throw new Error(es.job_id ? 'job running' : 'job lost'); }
        if (!es) throw new Error('still pending');
        resolved.push(...es);
        // review entries stay on the device until confirmed
        // review entries sync too (state needs_review): they count for the server streak, not in totals
        rest.push(...es.map((entry): Op => ({ kind: 'upsert', entry, tries: 0 })));
        // a job that ended for good without a number (gave_up / error): abandoned on the server, as the backstop does, so a
        // late AI reading for it is never saved (sent in order after the failed row)
        const job = op.food.job_id;
        if (job && es.some((x) => FINAL_FAIL_REASONS.includes(x.ai_fail_reason ?? '')) && !rest.some((o) => o.kind === 'abandon' && o.id === job)) rest.push({ kind: 'abandon', id: job, tries: 0 });
      }
      rest.splice(i, 1);
    } catch (e) {
      // refused save: not dropped, it goes back to the user as an item to review (the store re-queues it as needs_review)
      // a 400/422 is final for this op: never retried forever (a review entry refused again is dropped from the queue but stays on the phone)
      // 404 on a save: the row was deleted on the server (another device). The delete wins: never re-created, never retried.
      if (op.kind === 'upsert' && statusOf(e) === 404) { gone.push(op.entry.id); rest.splice(i, 1); continue; }
      // CEO: the edit was based on a version the server has moved on from (another device saved since): never re-applied
      if (op.kind === 'upsert' && isStaleEdit(e, op)) { stale.push({ id: op.entry.id, row: (e as { entry: ServerRow }).entry, sent: op.entry }); rest.splice(i, 1); continue; }
      // rg10 (CEO): a DELETE refused with a 4xx other than 404 (404 = already gone: the delete wins, see api.deleteEntry) means
      // the row stays on the server. 401/408/429 are retried as before. A 409 (e.g. version_conflict with the server's copy;
      // e461c87 never sends one on DELETE) is retried once at once, then kept with the copy it sent.
      if (op.kind === 'delete' && (isRefusalStatus(statusOf(e)) || statusOf(e) === 409)) {
        const row = (e as { entry?: ServerRow })?.entry;
        if (statusOf(e) === 409 && !conflicted.has(op.id)) { conflicted.set(op.id, { row, reason: reasonOf(e) }); continue; }
        let copy = row ?? conflicted.get(op.id)?.row;
        // next build: the row had an edit the server never got: its own copy (qty, unit, numbers) decides what the phone shows
        if (!copy && op.edited && s.getEntry) { try { copy = (await s.getEntry(op.id)) ?? undefined; } catch { /* unknown: restoreKept falls back */ } }
        kept.push({ id: op.id, code: codeOf(e) || `http_${statusOf(e)}`, reason: reasonOf(e) ?? conflicted.get(op.id)?.reason, row: copy, ...(op.edited ? { edited: true } : {}) });
        rest.splice(i, 1); continue;
      }
      // any other 4xx on the PATCH of a row the server already has (409 = the version / abandon flows; 401/408/429 retry):
      // the server kept its copy, so the phone's row is NEVER rewritten (no 0-kcal review row). It keeps the user's value,
      // shows "Couldn't sync this. Tap to retry" with the server's reason, and the rest of the queue keeps flowing.
      if (op.kind === 'upsert' && (isPatchRefusal(e) || isRefusal(e, op))) {
        // a pick the server asks for on an EDIT (variant_required): the row says so in plain words and tapping it opens the
        // choices (Today); the server's developer message is never shown
        const pick = CHOICE_CODES.includes(codeOf(e));
        const vo = (e as { variantOptions?: FoodEntry['variant_options'] })?.variantOptions;
        failed.push({ id: op.entry.id, code: codeOf(e) || `http_${statusOf(e)}`, sent: op.entry, reason: pick ? choiceCopy(codeOf(e)) : reasonOf(e), ...(pick && vo?.length ? { options: vo } : {}) });
        rest.splice(i, 1); continue;
      }
      if (isRejection(e, op)) {
        if (op.kind === 'profile') profileRejected = codeOf(e) || 'unknown';
        else if (op.kind === 'upsert' && !op.entry.needs_review) {
          const vo = (e as { variantOptions?: FoodEntry['variant_options'] })?.variantOptions;
          rejected.push({ entry: op.entry, code: codeOf(e), ...(vo?.length ? { variant_options: vo } : {}) });
        }
        rest.splice(i, 1); continue;
      }
      // can't be applied (e.g. still a conflict after the one re-apply): shown on the entry, never jams the queue
      if (isStuck(e, op, op.tries + 1)) {
        failed.push(op.kind === 'upsert' ? { id: op.entry.id, code: codeOf(e) || `http_${statusOf(e)}`, sent: op.entry } : { id: (op as { id: string }).id, code: codeOf(e) || `http_${statusOf(e)}` });
        rest.splice(i, 1); continue;
      }
      const cur = rest[i];
      // offline (no status) resets the 5xx run; a 5xx adds to it
      const fives = statusOf(e) >= 500 ? (op.fives ?? 0) + 1 : 0;
      if (fives >= MAX_FIVES && op.kind === 'upsert') {
        failed.push({ id: op.entry.id, code: SERVER_ERROR, sent: op.entry });
        rest.splice(i, 1); continue;
      }
      if (fives >= MAX_FIVES && op.kind === 'delete') { // flagged on the (deleted) row: "Couldn’t sync this. Tap to retry"
        failed.push({ id: op.id, code: SERVER_ERROR, reason: NOT_DELETED_REASON });
        rest.splice(i, 1); continue;
      }
      rest[i] = { ...cur, tries: op.tries + 1, fives, nextAt: now + backoffMs(op.tries + 1), net: statusOf(e) < 500 } as Op;
      if (statusOf(e) >= 500) { parked.add(k); i++; continue; } // the server is up: other ids go on
      break; // no connection (or a wait the server asked for): everything waits
    }
  }
  return { rest, resolved, rejected, profileRejected, versions, failed, gone, rows, kept, stale };
}

/** Queued pending foods for a day (shown as '— kcal', never counted). */
export const pendingFor = (q: Op[], date?: string): PendingFood[] =>
  q.flatMap((o) => (o.kind === 'pending' && (!date || o.food.local_date === date) ? [o.food] : []));

/** Designer: a queued food still unresolved after ~10 s moves to "items to review". */
export const STALE_PENDING_MS = 10_000;
export const isStale = (f: PendingFood, now = Date.now()) => now - (f.at ?? 0) >= STALE_PENDING_MS;
/** Offline = the head of the queue has failed at least once. */
export const isOffline = (q: Op[]) => q.some((o) => o.tries > 0);
