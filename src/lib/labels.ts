import type { Slot } from './domain';
export const SLOT_LABEL: Record<Slot, string> = { breakfast: 'Breakfast', lunch: 'Lunch', snacks: 'Snacks', dinner: 'Dinner' };
export const SLOTS: Slot[] = ['breakfast', 'lunch', 'snacks', 'dinner'];
export const SOURCE_LABEL = (source: string) =>
  source === 'ai' ? 'AI estimate' : source === 'open_food_facts' ? 'label' : source === 'usda_fdc' ? 'USDA estimate' : source === 'manual' || source === 'custom' ? 'your entry' : 'recipe estimate';
/** next build: the amount of a row whose server amount isn't known yet (a refused delete whose server copy couldn't be read) */
export const AMOUNT_UNKNOWN = '—';
/** rg10 note: the app's word for a unit in user copy. 'count' is never shown as a word: it reads "piece" / "pieces". */
export const unitWord = (unit: string, plural = false) => (unit === 'count' ? (plural ? 'pieces' : 'piece') : unit);
export function portionLabel(qty: number, unit: string, name = '') {
  if (unit === 'count') return `${qty} ${qty === 1 ? 'piece' : 'pieces'}`;
  if (unit === 'gram') return `${qty} g`;
  return `${qty} ${unit}${qty !== 1 && unit !== 'katori' ? 's' : ''}`.trim() + (name ? '' : '');
}

/** CEO / Designer (next build): the edit sheet's unit chips. A dish that comes in 'piece' doesn't also show 'count': in the
 * dish table the two are the same thing (equal per-unit kcal, grams and macros for every dish that has both: unit sweep test).
 * The one piece chip stands for both: it is selected on a count row and tapping it keeps that row's own unit, so a count row
 * is never converted (nothing changes on the server). Where count is the only option its chip reads "piece" (singular, like
 * katori / spoon / plate / gram). Display only: the saved units and the server's list are unchanged. Pure. */
export function unitChips(units: string[], current: string): { unit: string; label: string; selected: boolean }[] {
  const shared = units.includes('piece') && units.includes('count');
  return units.filter((u) => !(shared && u === 'count')).map((u) => {
    const selected = u === current || (shared && u === 'piece' && current === 'count');
    return { unit: selected ? current : u, label: u === 'count' ? 'piece' : u, selected };
  });
}
