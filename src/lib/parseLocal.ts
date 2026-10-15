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
/** Mirrors food.ItemIn per API.md "App contract" (backend ea9dd85). Table items carry the
 * confirmed numbers + dish_table_version; the server checks them and never recalculates. */
type Nums = { kcal: number; kcal_low: number; kcal_high: number; protein_g: number; protein_low: number; protein_high: number; carbs_g?: number; fat_g?: number };
export type ItemIn =
  | ({ dish_id: string; qty: number; unit: string; oil_level: string; source: string; confirmed: boolean; client_id: string; dish_table_version: number; span?: string } & Nums)
  | ({ custom_name: string; source: string; confirmed: boolean; client_id: string; span?: string } & Nums);

export function totalOf(items: Item[]): ParseTotal {
  const [k, p] = totals(items);
  let c = 0, f = 0;
  for (const it of items) { c += it.carbs_g; f += it.fat_g; }
  return { kcal: k.best, kcal_low: k.low, kcal_high: k.high, protein_g: p.best, protein_low: p.low, protein_high: p.high, carbs_g: Math.round(c * 10) / 10, fat_g: Math.round(f * 10) / 10 };
}

/** Backend e672dbe contract (food.Service.Parse): an item held back only because the meal had other unknown
 * words is claimed as a confident table item (parser.Claim). Otherwise unchanged. */
export function uncascade(it: Item): Item {
  return parser.claim(it) ?? it;
}

/** Claims for a parsed meal; a claimed table word glued (only whitespace between) to unknown words
 * ("kuttu cheela") stays unclaimed, since the phrase may be one unknown dish (backend rule). */
export function claimAll(text: string, items: Item[], unmatched: string[]): Item[] {
  const open = unmatched.filter((u) => !parser.noise(u)).map((u) => parser.locateWords(text, u)).filter((x) => x[2]);
  return items.map((it) => {
    const c = parser.claim(it);
    if (!c) return it;
    const glued = open.some(([s, e]) => (it.span_end <= s && text.slice(it.span_end, s).trim() === '') || (e <= it.span_start && text.slice(e, it.span_start).trim() === ''));
    return glued ? it : c;
  });
}

/** AI items overlapping a table item (UTF-16 span offsets) are dropped: the table claimed that text. */
export function dropOverlapping<T extends { span_start?: number; span_end?: number }>(table: T[], ai: T[]): T[] {
  return ai.filter((a) => a.span_start === undefined || a.span_end === undefined ||
    !table.some((t) => t.span_start !== undefined && t.span_end !== undefined && a.span_start! < t.span_end && t.span_start < a.span_end!));
}

/** Offline parse, mirroring food.Service.Parse with use_ai=false: unknown food-like
 * text becomes a generic placeholder item (never 0 kcal) plus a custom item. */
export function parseLocal(text: string, now = new Date()): ParseResponse {
  const t = text.trim();
  const r = parser.parse(t);
  const items: Item[] = claimAll(t, r.items, r.unmatched); // everyday combos arrive as their parts (parser rule, same as backend)
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

