// Pending foods: added while the network/AI was unavailable. They are kept in
// the sync queue with NO numbers and filled in only when the server resolves them.
import { DISH_TABLE_VERSION } from '../parser';
import type { ParseResponse } from './parseLocal';
import { autoSavable, entryFromItem, FoodEntry, reviewEntry } from './domain';
import { isPlaceholder } from './itemKind';
import type { PendingFood } from './syncQueue';

/** Entries for a resolved span, or null while it is still unknown (cap reached, AI off, placeholder only). Ids derive from the
 * pending id, so a retried resolve is idempotent on the server (client_id). */
export async function resolvePending(api: { parse(t: string, ai?: boolean): Promise<ParseResponse> }, f: PendingFood): Promise<FoodEntry[] | null> {
  const r = await api.parse(f.span, true);
  const got = r.items.filter((it) => !isPlaceholder(it) && it.kcal.best > 0);
  if (!got.length) return null;
  // only a confident table match is saved; anything uncertain becomes a 'needs review' entry (no unwarned number)
  return got.map((it, i) => {
    const o = { id: `${f.id}-${i}`, slot: f.slot, raw_text: f.raw_text, local_date: f.local_date, tableVersion: DISH_TABLE_VERSION };
    return autoSavable(it) ? entryFromItem(it, o) : reviewEntry(it, o);
  });
}
