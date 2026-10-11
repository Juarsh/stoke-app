// "Did you mean…?" check, mirroring the backend change announced 12 Oct:
// items over 1000 kcal or over 3× their standard portion get needs_confirm
// plus suggested alternatives. Kept OUTSIDE the parser port so parser.ts stays
// a line-for-line mirror of parser.go. Re-check thresholds/shape against
// /workspace/calorie-tracker API.md once the backend ships it.
import { Item, parser } from '../parser';

export const MAX_KCAL = 1000;
export const MAX_PORTIONS = 3;
export type CheckedItem = Item & { needs_confirm?: boolean; alternatives?: Item[] };

export function check(it: Item): CheckedItem {
  const d = parser.dishById(it.dish_id);
  if (!d || it.ai_estimate) return it;
  const tooBig = it.kcal.best > MAX_KCAL || it.grams > MAX_PORTIONS * d.portion_grams;
  if (!tooBig) return it;
  const alts: Item[] = [];
  const seen = new Set<string>();
  const push = (x: Item) => { const k = `${x.quantity}|${x.unit}`; if (!seen.has(k) && k !== `${it.quantity}|${it.unit}`) { seen.add(k); alts.push(x); } };
  push(parser.edit(it, { quantity: 1, unit: d.unit }));                       // one standard portion
  if (it.unit === 'gram') push(parser.edit(it, { quantity: Math.round(it.quantity / 10), unit: 'gram' })); // "2000g" -> 200 g typo
  else if (it.quantity >= 10) push(parser.edit(it, { quantity: Math.round(it.quantity / 10), unit: it.unit }));
  if (d.unit !== 'count' && it.unit !== d.unit) push(parser.edit(it, { quantity: 1, unit: 'spoon' }));
  return { ...it, needs_confirm: true, alternatives: alts.slice(0, 3) };
}
