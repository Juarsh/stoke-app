// rg6 F1: after a save the phone shows the row as the SERVER stored it. If the server kept it for review (needs_review: e.g.
// a unit the dish doesn't come in, from an older build's queue) the row goes to Review, not counted, with a readable note; if
// it stored other numbers or another amount, the row takes the server's numbers (counted as the server counts them) and says
// so. Phone == server == /v1/summary after every sync. Pure (testable).
import { parser, type Item } from '../parser';
import type { ServerRow } from './api';
import { unitSupportedFor, type FoodEntry } from './domain';

const near = (a: number | undefined, b: number) => typeof a !== 'number' || Math.abs(a - b) <= 0.5;
const fmt = (n: number) => n.toLocaleString('en-IN');
export const SERVER_REVIEW = 'server_review';
export function reviewNote(e: FoodEntry): string {
  if (e.dish_id && e.unit && !unitSupportedFor(e.dish_id, e.unit)) return `Not counted yet: this dish doesn’t come in ${e.unit}. Check the amount and add it again.`;
  return 'Not counted yet: this needs a check. Look at it and add it again.';
}
function itemOf(e: FoodEntry, row: ServerRow): Item {
  const dish = row.dish_id ?? e.dish_id;
  if (dish && parser.dishById(dish)) {
    try { return { ...parser.recompute(dish, row.qty ?? e.qty, row.unit ?? '', row.oil_level || e.oil_level || ''), needs_confirmation: true, matched_text: e.span ?? e.raw_text }; } catch { /* below */ }
  }
  const k = row.kcal_best ?? e.kcal.best, p = row.protein_best ?? e.protein_g.best;
  return { dish_id: dish ?? '', name: row.name || e.custom_name || e.raw_text, matched_text: e.span ?? e.raw_text, quantity: row.qty ?? e.qty, unit: row.unit ?? e.unit, grams: 0,
    oil_level: e.oil_level, kcal: { low: row.kcal_low ?? k, best: k, high: row.kcal_high ?? k }, protein_g: { low: row.protein_low ?? p, best: p, high: row.protein_high ?? p },
    carbs_g: row.carbs_g ?? 0, fat_g: row.fat_g ?? 0, source: 'did_you_mean', data_source: '', source_note: e.source_note, fuzzy: false, needs_confirmation: true,
    default_portion: false, span_start: 0, span_end: 0, ai_estimate: false } as Item;
}
/** The phone's entry after a save the server answered with `row` (only for an entry unchanged since it was sent). */
export function adoptServer(e: FoodEntry, row: ServerRow): FoodEntry {
  if (!row || !row.state || e.needs_review || e.pending || e.deleted_at) return e;
  if (row.state === 'needs_review') {
    const z = { low: 0, best: 0, high: 0 };
    return { ...e, kcal: z, protein_g: z, carbs_g: 0, fat_g: 0, confirmed: false, needs_review: true, review_item: itemOf(e, row),
      reject_code: SERVER_REVIEW, server_note: reviewNote(e) };
  }
  const dishRow = !!e.dish_id;
  const same = near(row.kcal_best, e.kcal.best) && near(row.protein_best, e.protein_g.best)
    && (!dishRow || ((row.qty ?? e.qty) === e.qty && (row.unit ?? e.unit) === e.unit && (row.dish_id ?? e.dish_id) === e.dish_id));
  if (same) return e;
  const k = row.kcal_best ?? e.kcal.best, p = row.protein_best ?? e.protein_g.best;
  const qty = row.qty ?? e.qty, unit = row.unit ?? e.unit;
  return { ...e, dish_id: dishRow ? row.dish_id ?? e.dish_id : e.dish_id, qty, unit,
    kcal: { low: row.kcal_low ?? k, best: k, high: row.kcal_high ?? k }, protein_g: { low: row.protein_low ?? p, best: p, high: row.protein_high ?? p },
    carbs_g: row.carbs_g ?? e.carbs_g, fat_g: row.fat_g ?? e.fat_g,
    server_note: dishRow ? `Saved as ${fmt(qty)} ${unit} · ${fmt(k)} kcal.` : `Saved as ${fmt(k)} kcal.` };
}
