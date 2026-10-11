// Pure (no React Native imports) so the Tester CLI can use it under Node.
import { Item, parser, totals } from '../parser';
import type { Slot } from './domain';
import { slotFor } from './domain';

export type Fallback = 'none' | 'used' | 'not_configured' | 'cap_reached' | 'error';
export interface ParseTotal { kcal: number; kcal_low: number; kcal_high: number; protein_g: number; protein_low: number; protein_high: number }
/** Mirrors food.ParseResponse in the Go backend. */
export interface ParseResponse {
  items: Item[]; unmatched: string[]; total: ParseTotal; used_ai: boolean; fallback: Fallback;
  custom_items: { custom_name: string; needs_input: boolean }[]; message?: string; slot: Slot;
}
/** Mirrors food.ItemIn. We always send the saved snapshot numbers. */
export interface ItemIn {
  dish_id?: string; qty: number; unit: string; oil_level: string; custom_name?: string;
  kcal: number; kcal_low: number; kcal_high: number; protein_g: number; protein_low: number; protein_high: number;
  source: string; client_id: string; dish_table_version: number;
}

export function totalOf(items: Item[]): ParseTotal {
  const [k, p] = totals(items);
  return { kcal: k.best, kcal_low: k.low, kcal_high: k.high, protein_g: p.best, protein_low: p.low, protein_high: p.high };
}

/** Offline parse in the backend's /v1/parse response shape (no AI: unmatched -> custom items). */
export function parseLocal(text: string, now = new Date()): ParseResponse {
  const r = parser.parse(text.trim());
  return {
    items: r.items, unmatched: r.unmatched, total: totalOf(r.items), used_ai: false,
    fallback: 'none', custom_items: r.unmatched.map((u) => ({ custom_name: u, needs_input: true })), slot: slotFor(now),
  };
}

