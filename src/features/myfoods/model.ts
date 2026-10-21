// My foods (spec §6): the user's reusable foods. Stored on the phone with the rest of the app state (LocalStore), so they
// work offline. Nutrition is per the food's own unit and amount (per 1 piece, per 250 ml). Logged rows are snapshots:
// editing or deleting a food never changes them.
import { TYPED_KCAL_REASON, KCAL_MAX } from '@/lib/domain';
import type { UiUnit } from '@/features/logfood/model';

export interface MyFood {
  id: string; name: string;
  unit: UiUnit; amount: number;
  kcal: number; protein: number; carbs?: number; fat?: number;
  /** grams in one piece / bowl (More); adds g as an extra unit */
  unitGrams?: number;
  created_at: string; updated_at: string; deleted_at: string | null;
}
export const isMine = (f: object): f is MyFood => 'unit' in f && 'amount' in f && !('aliases' in f);
export const activeFoods = (all: MyFood[]) => all.filter((f) => !f.deleted_at);
/** §6.5: lowercase, trim, collapse spaces, a hyphen is a space. Spelling differences are not merged. */
export const clashKey = (s: string) => s.toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
/** Another active food of the user's with the same name (a deleted food's name can be reused; table names never clash). */
export function clashOf(name: string, all: MyFood[], selfId?: string): MyFood | null {
  const k = clashKey(name);
  if (!k) return null;
  return activeFoods(all).find((f) => f.id !== selfId && clashKey(f.name) === k) ?? null;
}

/** The form as typed (strings), §6.4. Protein starts blank, not 0. */
export interface Draft { name: string; unit: UiUnit; amount: string; kcal: string; protein: string; carbs: string; fat: string; unitGrams: string }
export const DEFAULT_AMOUNT: Record<UiUnit, number> = { piece: 1, bowl: 1, g: 100, ml: 250 };
export function newDraft(name = '', unit: UiUnit = 'piece'): Draft {
  return { name, unit, amount: String(DEFAULT_AMOUNT[unit]), kcal: '', protein: '', carbs: '', fat: '', unitGrams: '' };
}
export const draftOf = (f: MyFood): Draft => ({ name: f.name, unit: f.unit, amount: String(f.amount), kcal: String(f.kcal), protein: String(f.protein),
  carbs: f.carbs === undefined ? '' : String(f.carbs), fat: f.fat === undefined ? '' : String(f.fat), unitGrams: f.unitGrams === undefined ? '' : String(f.unitGrams) });
/** Unit change: the new unit's usual amount (1 piece, 1 bowl, 100 g, 250 ml); grams per unit only for piece / bowl. */
export const draftUnit = (d: Draft, u: UiUnit): Draft => ({ ...d, unit: u, amount: String(DEFAULT_AMOUNT[u]), unitGrams: u === 'piece' || u === 'bowl' ? d.unitGrams : '' });

export const CLASH_REASON = 'You already have this food';
export const NAME_REASON = 'Enter a name.';
export const AMOUNT_REASON = 'Enter an amount between 1 and 5,000.';
export const PROTEIN_BLANK_REASON = 'Enter protein. 0 is fine';
export const PROTEIN_REASON = 'Enter between 0 and 300 g protein.';
export const MACRO_REASON = 'Enter 0 or more, or leave it blank.';
export const GRAMS_REASON = 'Enter the grams in one, or leave it blank.';
export type Field = 'name' | 'amount' | 'kcal' | 'protein' | 'carbs' | 'fat' | 'unitGrams';
const num = (s: string) => (s.trim() === '' ? NaN : Number(s.trim().replace(',', '.')));

/** Field errors for a draft (first one gets focus on Save). Same limits as the store gate for a typed row. */
export function draftErrors(d: Draft, all: MyFood[], selfId?: string): Partial<Record<Field, string>> {
  const e: Partial<Record<Field, string>> = {};
  if (!d.name.trim()) e.name = NAME_REASON;
  else if (clashOf(d.name, all, selfId)) e.name = CLASH_REASON;
  const a = num(d.amount);
  if (!(a > 0 && a <= 5000)) e.amount = AMOUNT_REASON;
  const k = num(d.kcal);
  if (!(Number.isFinite(k) && k >= 1 && k <= KCAL_MAX)) e.kcal = TYPED_KCAL_REASON;
  if (d.protein.trim() === '') e.protein = PROTEIN_BLANK_REASON;
  else { const p = num(d.protein); if (!(p >= 0 && p <= 300)) e.protein = PROTEIN_REASON; }
  for (const f of ['carbs', 'fat'] as const) if (d[f].trim() !== '' && !(num(d[f]) >= 0 && num(d[f]) <= 1000)) e[f] = MACRO_REASON;
  if (d.unitGrams.trim() !== '' && !(num(d.unitGrams) > 0 && num(d.unitGrams) <= 5000)) e.unitGrams = GRAMS_REASON;
  return e;
}
export const FIELD_ORDER: Field[] = ['name', 'amount', 'kcal', 'protein', 'carbs', 'fat', 'unitGrams'];
const r1 = (x: number) => Math.round(x * 10) / 10;
/** A valid draft as a food (create: new id; edit: same id, created_at kept). null when it has errors. */
export function foodFromDraft(d: Draft, all: MyFood[], o: { id: string; now?: Date; prev?: MyFood }): MyFood | null {
  if (Object.keys(draftErrors(d, all, o.prev?.id ?? o.id)).length) return null;
  const now = (o.now ?? new Date()).toISOString();
  const opt = (s: string) => (s.trim() === '' ? undefined : r1(num(s)));
  return {
    id: o.prev?.id ?? o.id, name: d.name.trim().replace(/\s+/g, ' '), unit: d.unit, amount: r1(num(d.amount)),
    kcal: Math.round(num(d.kcal)), protein: r1(num(d.protein)), carbs: opt(d.carbs), fat: opt(d.fat),
    unitGrams: d.unit === 'piece' || d.unit === 'bowl' ? opt(d.unitGrams) : undefined,
    created_at: o.prev?.created_at ?? now, updated_at: now, deleted_at: null,
  };
}
