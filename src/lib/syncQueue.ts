// Offline-first sync queue. Ops are persisted and replayed in order; the
// payload is the entry snapshot, so syncing never recalculates numbers.
import type { FoodEntry } from './domain';

export type Op = { kind: 'upsert'; entry: FoodEntry; tries: number } | { kind: 'delete'; id: string; tries: number };
export interface Sender { upsertEntry(e: FoodEntry): Promise<void>; deleteEntry(id: string): Promise<void> }

/** Coalesce: a newer upsert/delete for the same id replaces older queued ops. */
export function enqueue(q: Op[], op: Op): Op[] {
  const id = op.kind === 'upsert' ? op.entry.id : op.id;
  return [...q.filter((o) => (o.kind === 'upsert' ? o.entry.id : o.id) !== id), op];
}

/** Sends ops in order; stops at the first failure (keeps it with tries+1). Returns the remaining queue. */
export async function flush(q: Op[], s: Sender): Promise<Op[]> {
  const rest = [...q];
  while (rest.length) {
    const op = rest[0];
    try {
      if (op.kind === 'upsert') await s.upsertEntry(op.entry); else await s.deleteEntry(op.id);
      rest.shift();
    } catch {
      rest[0] = { ...op, tries: op.tries + 1 };
      break;
    }
  }
  return rest;
}
