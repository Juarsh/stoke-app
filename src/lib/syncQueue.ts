// Offline-first sync queue. Ops are persisted and replayed in order; the payload
// is the entry snapshot, so syncing never recalculates numbers.
// Nothing is ever dropped: on a 409 or any error the op stays at the head with
// tries+1 and a backoff (5 s doubling, max 30 min), and is retried later.
import type { FoodEntry, Slot } from './domain';

/** A food the user added while its numbers were still unknown (network / AI). Never saved with a number. */
export interface PendingFood { id: string; span: string; slot: Slot; local_date: string; raw_text: string }
type Retry = { tries: number; nextAt?: number };
export type Op =
  | ({ kind: 'upsert'; entry: FoodEntry } & Retry)
  | ({ kind: 'delete'; id: string } & Retry)
  | ({ kind: 'pending'; food: PendingFood } & Retry)
  | ({ kind: 'forget'; id: number } & Retry)
  | ({ kind: 'forgetAll'; id: 'all' } & Retry);
export interface Sender {
  upsertEntry(e: FoodEntry): Promise<void>; deleteEntry(id: string): Promise<void>;
  /** Resolve a pending food into entries, or null if still unknown (stays queued). */
  resolvePending(f: PendingFood): Promise<FoodEntry[] | null>;
  deleteRemembered(id?: number): Promise<void>;
}

const opId = (o: Op) => (o.kind === 'upsert' ? o.entry.id : o.kind === 'pending' ? o.food.id : `${o.kind}:${o.id}`);

/** Coalesce: a newer op for the same id replaces older queued ops. */
export function enqueue(q: Op[], op: Op): Op[] {
  const id = op.kind === 'delete' ? op.id : opId(op);
  return [...q.filter((o) => (o.kind === 'delete' ? o.id : opId(o)) !== id), op];
}

export const backoffMs = (tries: number) => Math.min(30 * 60_000, 5_000 * 2 ** Math.max(0, tries - 1));

/** Sends ops in order; stops at the first failure or backoff wait. Returns the remaining queue and entries resolved from pending foods. */
export async function flush(q: Op[], s: Sender, now = Date.now()): Promise<{ rest: Op[]; resolved: FoodEntry[] }> {
  const rest = [...q];
  const resolved: FoodEntry[] = [];
  while (rest.length) {
    const op = rest[0];
    if (op.nextAt && op.nextAt > now) break; // keep order: wait for the head's backoff
    try {
      if (op.kind === 'upsert') await s.upsertEntry(op.entry);
      else if (op.kind === 'delete') await s.deleteEntry(op.id);
      else if (op.kind === 'forget') await s.deleteRemembered(op.id);
      else if (op.kind === 'forgetAll') await s.deleteRemembered();
      else {
        const es = await s.resolvePending(op.food);
        if (!es) throw new Error('still pending');
        resolved.push(...es);
        // review entries stay on the device until confirmed
        rest.push(...es.filter((e) => !e.needs_review).map((entry): Op => ({ kind: 'upsert', entry, tries: 0 })));
      }
      rest.shift();
    } catch {
      rest[0] = { ...op, tries: op.tries + 1, nextAt: now + backoffMs(op.tries + 1) } as Op;
      break;
    }
  }
  return { rest, resolved };
}

/** Queued pending foods for a day (shown as '— kcal', never counted). */
export const pendingFor = (q: Op[], date?: string): PendingFood[] =>
  q.flatMap((o) => (o.kind === 'pending' && (!date || o.food.local_date === date) ? [o.food] : []));
