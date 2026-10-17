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
