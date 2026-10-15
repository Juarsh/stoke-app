// One calculation for unit choices on Log's decision card: the item a choice produces is what the row shows,
// what the total/button sum, and what gets saved. (Bug: the card used to *highlight* the alternative while the
// draft kept the parsed unit, so "8 pieces" looked selected but 8 plates' kcal was shown, totalled and saved.)
import { Item, parser } from '../parser';
import { portionLabel } from './labels';

export const unitKey = (it: { quantity: number; unit: string }) => `${it.quantity}|${it.unit}`;

/** Item recomputed for a quantity/unit from the dish table (parser.edit), keeping source + alternatives. */
export function withUnit(it: Item, quantity: number, unit: string): Item {
  if (it.quantity === quantity && it.unit === unit) return it;
  return { ...parser.edit(it, { quantity, unit }), source: it.source, alternatives: it.alternatives };
}

export type Choice = { key: string; label: string; item: Item };
/** The card's options: the first alternative and the reading as typed, each recomputed for its unit.
 * The highlighted option is whichever unit the item currently holds (unitKey(it)). */
export function unitChoices(it: Item): Choice[] {
  const a = it.alternatives?.[0];
  if (!a) return [];
  return [a, it].map((u) => ({ key: unitKey(u), label: portionLabel(u.quantity, u.unit), item: withUnit(it, u.quantity, u.unit) }));
}

/** Picking an option confirms that exact recomputed item. */
export function choose(it: Item, key: string): Item {
  const c = unitChoices(it).find((x) => x.key === key)?.item ?? it;
  return { ...c, needs_confirmation: false, alternatives: undefined };
}
