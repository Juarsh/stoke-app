// Remembered foods: "text → reading" the user confirmed or corrected. Applied on the
// next parse so the same text never asks again. Pure (testable).
import { Item, parser } from '../parser';

/** Local cache of the server's Remembered foods (GET /v1/remembered); id is set once the server has it. */
export interface Reading { id?: number; dish_id: string; name: string; qty: number; unit: string; oil_level: string; at: string; uses?: number }
export type Learned = Record<string, Reading>;
/** Mirrors Go food.Normalize: lower case, letters/digits/'.'/combining marks kept, single spaces. */
export const learnKey = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\p{Mn}\p{Mc}.]/gu, ' ').split(/\s+/).filter(Boolean).join(' ');

/** Server rows -> local cache (server is the source of truth once online). */
export function fromRows(rows: { id: number; span: string; dish_id: string | null; custom_name: string; qty: number; unit: string; oil_level: string; uses: number; updated_at: string }[]): Learned {
  const out: Learned = {};
  for (const r of rows) {
    const d = r.dish_id ? parser.dishById(r.dish_id) : undefined;
    out[learnKey(r.span)] = { id: r.id, dish_id: r.dish_id ?? '', name: d?.name ?? r.custom_name, qty: r.qty, unit: r.unit, oil_level: r.oil_level, at: r.updated_at, uses: r.uses };
  }
  return out;
}
export type LoggedItem = Item & { remembered?: boolean };

/** Replace uncertain items whose text was confirmed/corrected before. */
export function applyLearned(items: Item[], learned: Learned): LoggedItem[] {
  return items.map((it) => {
    if (!it.needs_confirmation) return it;
    const r = learned[learnKey(it.matched_text)];
    if (!r || !parser.dishById(r.dish_id)) return it;
    const n = parser.edit(it, { dishId: r.dish_id !== it.dish_id ? r.dish_id : undefined, quantity: r.qty, unit: r.unit, oil: (r.oil_level || undefined) as never });
    return { ...n, source: 'table', needs_confirmation: false, alternatives: undefined, remembered: true };
  });
}
export const readingOf = (it: Item, now = new Date()): Reading =>
  ({ dish_id: it.dish_id, name: it.name, qty: it.quantity, unit: it.unit, oil_level: it.oil_level, at: now.toISOString() });

/** Muted reason word for a CHECK card (design-notes "Log confirm patterns"). */
export function reasonWord(it: Item): string {
  if (it.source === 'generic') return 'generic';
  if (it.alternatives?.length) return 'portion';
  if (it.source === 'did_you_mean') return 'fuzzy';
  if (it.from_combo) return 'combo';
  return 'check';
}
