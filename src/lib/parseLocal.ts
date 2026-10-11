// Pure (no React Native imports) so the Tester CLI can use it under Node.
import { Item, parser, totals } from '../parser';
import type { Slot } from './domain';
import { slotFor } from './domain';

export type Fallback = 'none' | 'used' | 'not_configured' | 'cap_reached' | 'error';
export interface ParseTotal { kcal: number; kcal_low: number; kcal_high: number; protein_g: number; protein_low: number; protein_high: number; carbs_g: number; fat_g: number }
/** Mirrors food.ParseResponse in the Go backend. */
export interface ParseResponse {
  items: Item[]; unmatched: string[]; total: ParseTotal; used_ai: boolean; needs_confirmation: boolean; fallback: Fallback;
  custom_items: { custom_name: string; needs_input: boolean }[]; message?: string; slot: Slot;
}
/** Mirrors food.ItemIn per API.md at backend 0b75f5b. The server rejects unknown
 * fields, so client_id / dish_table_version / carbs / fat are only sent once API.md
 * documents them (see ENTRY_EXTRA_FIELDS in api.ts). Dish rows are recomputed server-side. */
export type ItemIn =
  | { dish_id: string; qty: number; unit: string; oil_level: string; source: string; confirmed: boolean }
  | { custom_name: string; kcal: number; protein_g: number; source: string; confirmed: boolean };

export function totalOf(items: Item[]): ParseTotal {
  const [k, p] = totals(items);
  let c = 0, f = 0;
  for (const it of items) { c += it.carbs_g; f += it.fat_g; }
  return { kcal: k.best, kcal_low: k.low, kcal_high: k.high, protein_g: p.best, protein_low: p.low, protein_high: p.high, carbs_g: Math.round(c * 10) / 10, fat_g: Math.round(f * 10) / 10 };
}

/** Offline parse, mirroring food.Service.Parse with use_ai=false: unknown food-like
 * text becomes a generic placeholder item (never 0 kcal) plus a custom item. */
export function parseLocal(text: string, now = new Date()): ParseResponse {
  const r = parser.parse(text.trim());
  const items: Item[] = [...r.items];
  const custom_items: ParseResponse['custom_items'] = [];
  for (const u of r.unmatched) {
    if (!/\p{L}/u.test(u)) continue;
    items.push(parser.unknown(u));
    custom_items.push({ custom_name: u, needs_input: true });
  }
  return {
    items, unmatched: r.unmatched, total: totalOf(items), used_ai: false, needs_confirmation: items.some((i) => i.needs_confirmation),
    fallback: 'none', custom_items, slot: slotFor(now),
  };
}

