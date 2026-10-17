// rg6 F1: after a save the phone shows the row as the SERVER stored it. If the server kept it for review (needs_review: e.g.
// a unit the dish doesn't come in, from an older build's queue) the row goes to Review, not counted, with a readable note; if
// it stored other numbers or another amount, the row takes the server's numbers (counted as the server counts them) and says
// so. Phone == server == /v1/summary after every sync. Pure (testable).
import { parser, type Item } from '../parser';
import type { ServerRow } from './api';
import { portionLabel } from './labels';
import { kc } from './format';
import { CHECK_AMOUNT_LINE, notMeasured, serverSource, unitSupportedFor, UNITS_UNKNOWN, unitsKnown, type FoodEntry } from './domain';

const near = (a: number | undefined, b: number) => typeof a !== 'number' || Math.abs(a - b) <= 0.5;
export const SERVER_REVIEW = 'server_review';
/** The note on a row the server kept for review. Names the unit when the phone's list says the dish doesn't come in it, or
 * when the server stored it in another unit (its own, newer list: an older-table phone, rg7 B4). No unit: no unit clause. */
export function reviewNote(e: FoodEntry, row?: ServerRow): string {
  const unit = e.unit?.trim() ?? '';
  const serverMoved = !!row && !!row.unit && row.unit !== unit && !e.needs_review;
  if (e.dish_id && unit && (!unitSupportedFor(e.dish_id, unit) || serverMoved)) return `Not counted yet: ${notMeasured(e.dish_id, unit)}. ${CHECK_AMOUNT_LINE}`;
  if (e.dish_id && !unit) return `Not counted yet: ${CHECK_AMOUNT_LINE}`;
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
      reject_code: SERVER_REVIEW, server_note: reviewNote(e, row) };
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
    server_note: dishRow ? `Saved as ${portionLabel(qty, unit)} · ${kc(k)} kcal.` : `Saved as ${kc(k)} kcal.` };
}

export const UNITS_HELD = 'units_unknown';
/** PE: a table row for a dish the phone has no units for (never all 7): held as a review row, not counted, 'Check amount'.
 * It is saved on the server as needs_review (not counted there either) and checked in Review once the units come down. */
export function needsUnits(e: FoodEntry): boolean {
  return !!e.dish_id && !e.needs_review && !e.pending && !e.deleted_at && serverSource(e) !== 'ai_estimate' && serverSource(e) !== 'custom' && !unitsKnown(e.dish_id);
}
export function holdForUnits(e: FoodEntry): FoodEntry {
  const z = { low: 0, best: 0, high: 0 };
  const row: ServerRow = { qty: e.qty, unit: e.unit, dish_id: e.dish_id, kcal_best: e.kcal.best, kcal_low: e.kcal.low, kcal_high: e.kcal.high,
    protein_best: e.protein_g.best, protein_low: e.protein_g.low, protein_high: e.protein_g.high, carbs_g: e.carbs_g, fat_g: e.fat_g };
  return { ...e, kcal: z, protein_g: z, carbs_g: 0, fat_g: 0, confirmed: false, needs_review: true, review_item: itemOf(e, row),
    reject_code: UNITS_HELD, server_note: UNITS_UNKNOWN };
}
