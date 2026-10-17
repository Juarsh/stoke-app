// Offline-first sync queue. Ops are persisted and replayed in order; the payload
// is the entry snapshot, so syncing never recalculates numbers.
// Offline / server errors (no status, 5xx): the op stays at the head with tries+1 and a backoff (5 s doubling,
// max 30 min). A 409 never blocks the queue: a version conflict is resolved in the API (the user's edit re-applied
// on the server's version, retried once); what still can't be applied (409, other 4xx, or a 409 keep-and-retry
// after MAX_TRIES) is surfaced on its entry ("Couldn’t sync this. Tap to retry") and later ops keep flowing.
import type { FoodEntry, Slot } from './domain';

/** A food the user added while its numbers were still unknown (network / AI). Never saved with a number. */
export interface PendingFood { id: string; span: string; slot: Slot; local_date: string; raw_text: string; job_id?: string; /** ms when queued (0 = straight to items to review) */ at?: number;
  /** ms when its AI job started (Log estimate start, else when queued): the 35-minute backstop (aiBackstop) runs from here */ queued_at?: number }
type Retry = { tries: number; nextAt?: number };
export type Op =
  | ({ kind: 'upsert'; entry: FoodEntry } & Retry)
  | ({ kind: 'delete'; id: string } & Retry)
  | ({ kind: 'pending'; food: PendingFood } & Retry)
  | ({ kind: 'forget'; id: number } & Retry)
  | ({ kind: 'forgetAll'; id: 'all' } & Retry)
  /** the 35-minute backstop gave up on this parse job: POST /v1/parse/jobs/{id}/abandon (queued offline, sent when online) */
  | ({ kind: 'abandon'; id: string } & Retry)
  /** onboarding profile: queued even before sign-in, sent once signed in (ProfilePayload: on-device-only fields excluded) */
  | ({ kind: 'profile'; id: 'profile'; payload: import('./domain').ProfilePayload } & Retry);
export interface Sender {
  /** returns the server's row version for the entry, when the server sent one */
  upsertEntry(e: FoodEntry): Promise<void | { version?: number }>; deleteEntry(id: string): Promise<void>;
  /** Resolve a pending food into entries, or null if still unknown (stays queued). */
  /** entries, null (still unknown) or { job_id } (server is working on it: poll that job next time) */
  resolvePending(f: PendingFood): Promise<FoodEntry[] | null | { job_id: string }>;
  deleteRemembered(id?: number): Promise<void>;
  putProfile?(p: import('./domain').ProfilePayload): Promise<void>;
  /** POST /v1/parse/jobs/{id}/abandon; 404/410 count as done */
  abandonJob?(jobId: string): Promise<void>;
}

const opId = (o: Op) => (o.kind === 'upsert' ? o.entry.id : o.kind === 'pending' ? `pending:${o.food.id}` : `${o.kind}:${o.id}`);

/** Coalesce: a newer op for the same id replaces older queued ops. */
export function enqueue(q: Op[], op: Op): Op[] {
  const id = op.kind === 'delete' ? op.id : opId(op);
  return [...q.filter((o) => (o.kind === 'delete' ? o.id : opId(o)) !== id), op];
}

/** A save the server refused as invalid (400/422, e.g. a variant saved without a pick). Error code TBD by backend;
 * any 400/422 on a confirmed (non-review) upsert counts. Other errors keep the retry-with-backoff rule. */
export const isRejection = (e: unknown, op: Op) => isAbandonedSave(e, op) || ((op.kind === 'profile' || (op.kind === 'upsert' && !op.entry.pending))
  && typeof (e as { status?: unknown })?.status === 'number' && [400, 422].includes((e as { status: number }).status));
/** 409 job_abandoned: an AI reading saved with an abandoned job's id is refused for good (the user's typed kcal is what counts). */
export const isAbandonedSave = (e: unknown, op: Op) => op.kind === 'upsert' && (e as { status?: unknown })?.status === 409 && codeOf(e) === 'job_abandoned';
const codeOf = (e: unknown) => { const c = (e as { code?: unknown })?.code; return typeof c === 'string' ? c : ''; };

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

export const backoffMs = (tries: number) => Math.min(30 * 60_000, 5_000 * 2 ** Math.max(0, tries - 1));

/** Sends ops in order; stops at the first failure or backoff wait. Returns the remaining queue and entries resolved from pending foods. */
export type FlushResult = { rest: Op[]; resolved: FoodEntry[]; rejected: { entry: FoodEntry; code: string; variant_options?: FoodEntry['variant_options'] }[]; profileRejected?: string;
  /** entry id -> the server's row version after this flush */
  versions: Record<string, number>;
  /** entry ops that could not be applied (surfaced on the entry); `sent` is the op's entry snapshot (undefined for a delete) */
  failed: { id: string; code: string; sent?: FoodEntry }[] };
export async function flush(q: Op[], s: Sender, now = Date.now()): Promise<FlushResult> {
  const rest = [...q];
  const versions: Record<string, number> = {};
  const failed: FlushResult['failed'] = [];
  const resolved: FoodEntry[] = [];
  const rejected: { entry: FoodEntry; code: string; variant_options?: FoodEntry['variant_options'] }[] = [];
  let profileRejected: string | undefined;
  while (rest.length) {
    const op = rest[0];
    if (op.nextAt && op.nextAt > now) break; // keep order: wait for the head's backoff
    try {
      if (op.kind === 'upsert') {
        const known = versions[op.entry.id] ?? op.entry.server_version;
        const r = await s.upsertEntry(known === op.entry.server_version ? op.entry : { ...op.entry, server_version: known });
        if (r && typeof r.version === 'number') versions[op.entry.id] = r.version;
      }
      else if (op.kind === 'delete') await s.deleteEntry(op.id);
      else if (op.kind === 'forget') await s.deleteRemembered(op.id);
      else if (op.kind === 'forgetAll') await s.deleteRemembered();
      else if (op.kind === 'profile') { if (s.putProfile) await s.putProfile(op.payload); }
      else if (op.kind === 'abandon') { if (s.abandonJob) await s.abandonJob(op.id); }
      else {
        const es = await s.resolvePending(op.food);
        if (es && 'job_id' in es) { rest[0] = { ...op, food: { ...op.food, job_id: es.job_id || undefined } }; throw new Error(es.job_id ? 'job running' : 'job lost'); }
        if (!es) throw new Error('still pending');
        resolved.push(...es);
        // review entries stay on the device until confirmed
        // review entries sync too (state needs_review): they count for the server streak, not in totals
        rest.push(...es.map((entry): Op => ({ kind: 'upsert', entry, tries: 0 })));
      }
      rest.shift();
    } catch (e) {
      // refused save: not dropped, it goes back to the user as an item to review (the store re-queues it as needs_review)
      // a 400/422 is final for this op: never retried forever (a review entry refused again is dropped from the queue but stays on the phone)
      if (isRejection(e, op)) {
        if (op.kind === 'profile') profileRejected = codeOf(e) || 'unknown';
        else if (op.kind === 'upsert' && !op.entry.needs_review) {
          const vo = (e as { variantOptions?: FoodEntry['variant_options'] })?.variantOptions;
          rejected.push({ entry: op.entry, code: codeOf(e), ...(vo?.length ? { variant_options: vo } : {}) });
        }
        rest.shift(); continue;
      }
      // can't be applied (e.g. still a conflict after the one re-apply): shown on the entry, never jams the queue
      if (isStuck(e, op, op.tries + 1)) {
        failed.push(op.kind === 'upsert' ? { id: op.entry.id, code: codeOf(e) || `http_${statusOf(e)}`, sent: op.entry } : { id: (op as { id: string }).id, code: codeOf(e) || `http_${statusOf(e)}` });
        rest.shift(); continue;
      }
      const cur = rest[0];
      rest[0] = { ...cur, tries: op.tries + 1, nextAt: now + backoffMs(op.tries + 1) } as Op;
      break;
    }
  }
  return { rest, resolved, rejected, profileRejected, versions, failed };
}

/** Queued pending foods for a day (shown as '— kcal', never counted). */
export const pendingFor = (q: Op[], date?: string): PendingFood[] =>
  q.flatMap((o) => (o.kind === 'pending' && (!date || o.food.local_date === date) ? [o.food] : []));

/** Designer: a queued food still unresolved after ~10 s moves to "items to review". */
export const STALE_PENDING_MS = 10_000;
export const isStale = (f: PendingFood, now = Date.now()) => now - (f.at ?? 0) >= STALE_PENDING_MS;
/** Offline = the head of the queue has failed at least once. */
export const isOffline = (q: Op[]) => q.some((o) => o.tries > 0);
