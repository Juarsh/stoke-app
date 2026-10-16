// Confirm batch (design-notes "Confirm batch and inline estimates", v3.2 Oct 15).
// WHO DECIDES: the server marks one-tap-confirmable items with `one_tap_ok: true`. The app never derives it from
// flags; a missing field means false. As a CEO guard the app still refuses it for unit_mismatch items (unit_options),
// AI estimates and estimate_unverified items, even if the server sends true.
// Unconfirmed items are left out of every total; all kcal come from the API item (or its unit_options).
import type { Item } from '../parser';
import { oneTap, parser } from '../parser';
import { withUnit } from './decision';

export type ServerItem = Item & { one_tap_ok?: boolean };
export type Kind = 'counted' | 'batch' | 'unit' | 'estimate' | 'unverified' | 'choice';
const n = (x: number) => Math.round(x).toLocaleString('en-IN');

/** estimate_unverified, or a brand word no branded row matched (brand_unmatched): same unverified-estimate row as bhel */
export const isUnverified = (it: Item) => (it.flags ?? []).includes('estimate_unverified') || (it.flags ?? []).includes('brand_unmatched');
export const isUnitMismatch = (it: Item) => !!it.unit_options?.length || (it.flags ?? []).includes('unit_mismatch');
/** Server variant choice (backend 519964a, API.md "Variant choice"): flag `variant_choice` + `variant_options`.
 * Tolerant of field names (variant_options | variants | variant_choices; protein_g | protein; kcal number | {best}). */
export interface VariantOption { dish_id: string; name: string; kcal: number; protein_g: number }
const num = (x: unknown): number => (typeof x === 'number' ? x : x && typeof x === 'object' && typeof (x as { best?: unknown }).best === 'number' ? (x as { best: number }).best : NaN);
export function variantOptions(it: Item): VariantOption[] {
  const r = it as unknown as Record<string, unknown>;
  const raw = (r.variant_options ?? r.variants ?? r.variant_choices) as unknown;
  if (!Array.isArray(raw)) return [];
  return raw.map((o: Record<string, unknown>) => ({ dish_id: String(o.dish_id ?? o.id ?? ''), name: String(o.name ?? o.label ?? o.dish_id ?? ''), kcal: num(o.kcal ?? o.kcal_best), protein_g: num(o.protein_g ?? o.protein) }))
    .filter((o) => o && o.dish_id && o.name && Number.isFinite(o.kcal) && o.kcal > 0).map((o) => ({ ...o, protein_g: Number.isFinite(o.protein_g) ? o.protein_g : 0 }));
}
export const isVariantChoice = (it: Item) => (it.flags ?? []).includes('variant_choice') || variantOptions(it).length > 0;
export const isVague = (it: Item) => (it.flags ?? []).includes('vague_quantity');
/** The user picked a type: that variant's server numbers (portion already applied), confirmed, no longer a choice. */
export function pickVariant(it: Item, o: VariantOption): Item {
  const r = { ...(it as unknown as Record<string, unknown>) };
  delete r.variant_options; delete r.variants; delete r.variant_choices;
  const k = Math.round(o.kcal), p = Math.round(o.protein_g * 10) / 10;
  return { ...(r as unknown as Item), dish_id: o.dish_id, name: o.name, kcal: { low: k, best: k, high: k }, protein_g: { low: p, best: p, high: p },
    flags: (it.flags ?? []).filter((f) => f !== 'variant_choice'), needs_confirmation: false, alternatives: undefined, unit_options: undefined,
    variant_options_all: variantOptions(it), variant_dish_id: o.dish_id } as Item;
}
export const isAiEstimate = (it: Item) => it.ai_estimate || it.source === 'ai_estimate';

/** Placeholder / failed reading with no real number: generic unknown-food placeholder, failed AI (ai_state failed,
 * needs_input), or no kcal. Only the user's typed kcal can make it countable. */
export function isPlaceholder(it: Item): boolean {
  const r = it as unknown as Record<string, unknown>;
  if (!(Number.isFinite(it.kcal?.best) && it.kcal.best > 0)) return true;
  if (r.ai_state === 'failed' || r.needs_input === true || r.custom_item === true) return true;
  return !it.dish_id && !isAiEstimate(it); // parser.unknown(): source generic, no dish
}
const needsVerification = (it: Item) => !!(it.dish_id && parser.dishById(it.dish_id)?.needs_verification) || (it.flags ?? []).includes('needs_verification');
/** Reasons this item needs its OWN pick (chip or typed kcal): never part of any bulk / one-tap confirm. */
export function needsOwnPick(it: Item): boolean {
  return isVariantChoice(it) || isVague(it) || isUnitMismatch(it) || isUnverified(it) || needsVerification(it) || isPlaceholder(it) || isAiEstimate(it);
}
/**
 * THE single eligibility rule for every bulk confirm (Log "Confirm N / Add", Review "All look right"):
 * already confirmed by the user, or a confident item (no confirm needed), or a server one_tap_ok item, and never
 * an item that needs its own pick.
 */
export function bulkEligible(it: ServerItem, confirmed = false): boolean {
  if (confirmed) return !isPlaceholder(it);
  if (needsOwnPick(it)) return false;
  return !it.needs_confirmation || oneTapOk(it);
}
/** Review "All look right": unchecked review rows eligible under the same rule (server-refused rows never). */
export function reviewBulk<E extends { review_item?: Item; reject_code?: string }>(rows: E[]): E[] {
  return rows.filter((e) => !!e.review_item && !e.reject_code && bulkEligible({ ...e.review_item, one_tap_ok: (e.review_item as ServerItem).one_tap_ok ?? oneTap(e.review_item) } as ServerItem));
}
/** Explicit single confirm (store.confirmReview): the item must be a real, picked reading. */
export function canConfirm(it: Item): boolean {
  if (isPlaceholder(it)) return false;          // no real kcal
  if (isVariantChoice(it)) return false;       // variant not picked (pickVariant clears it)
  if (isVague(it)) return false;               // portion chip not picked (pickVague clears it)
  if (isUnitMismatch(it)) return false;        // unit not picked (pickUnit clears it)
  return true;
}

/** Server field only (missing = false), with the guard: never unit_mismatch, AI estimate or estimate_unverified. */
export function oneTapOk(it: ServerItem): boolean {
  if (it.one_tap_ok !== true) return false;
  return !needsOwnPick(it);
}

/** confirmed = the user already chose/confirmed this row in the app. */
export function kindOf(it: ServerItem, confirmed: boolean): Kind {
  if (confirmed) return 'counted';
  if (isUnitMismatch(it) || isVariantChoice(it) || isVague(it)) return 'unit'; // variant choice reuses the unit-mismatch open row
  if (isUnverified(it)) return 'unverified';
  if (isAiEstimate(it)) return 'estimate';
  if (!it.needs_confirmation) return 'counted';
  return oneTapOk(it) ? 'batch' : 'choice';
}

export type Row = { key: string; it: ServerItem; confirmed: boolean };
/** estimating = AI rows still estimating (not counted, no buttons, skipped by the batch). */
/** waiting = failed AI rows with no kcal yet: they count as items that still need a choice. */
export function plan(rows: Row[], estimating = 0, waiting = 0) {
  const add = rows.filter((r) => { const k = kindOf(r.it, r.confirmed); return (k === 'counted' || k === 'batch') && bulkEligible(r.it, r.confirmed); });
  const open = rows.filter((r) => !add.includes(r));
  const kcal = add.reduce((a, r) => a + r.it.kcal.best, 0);
  const protein = add.reduce((a, r) => a + r.it.protein_g.best, 0);
  const m = open.length + waiting, cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const still = m ? `${m} still ${m === 1 ? 'needs' : 'need'} a choice` : '';
  const est = estimating ? `${estimating} estimating` : '';
  let button: string, total: string, note = '', disabled = false;
  if (m === 0 && !estimating) { button = `Add ${n(kcal)} kcal`; total = 'Total'; }
  else if (open.length === 0 && waiting && add.length) { // only failed rows wait: keep "Add", never hide them
    button = [`Confirm ${add.length}`, est, still].filter(Boolean).join(' · '); // frame log-estimate-failed
    total = ['Total', est, still].filter(Boolean).join(' · ');
  }
  else if (add.length === 0) {
    button = m ? 'Choose for each item to add it' : `Add 0 kcal · ${est}`;
    total = ['Total', m ? `${m} ${m === 1 ? 'needs' : 'need'} a choice` : '', est].filter(Boolean).join(' · ');
    disabled = true;
  } else {
    button = [`Confirm ${add.length}`, est, still].filter(Boolean).join(' · ');
    total = ['Total', est, still].filter(Boolean).join(' · ');
    if (m) {
      const names = open.map((r) => cap(r.it.name));
      if (!names.length) names.push(`${waiting} custom ${waiting === 1 ? 'item' : 'items'}`);
      note = `Adds ${n(kcal)} kcal. ${names.length > 2 ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} more` : names.join(' and ')} ${m === 1 ? 'stays' : 'stay'} open.`;
    }
  }
  // secondary outline button: save what's confirmed, send every open item (incl. estimating + empty failed rows) to review
  const nLater = m + estimating;
  const later = nLater ? `${add.length ? `Add ${n(kcal)} kcal` : 'Save'} · ${nLater} to review later` : '';
  // confirm-none (design-notes Oct 15): no disabled main button; only the enabled outline 'Save · N to review later' shows
  const primary = !(add.length === 0 && !!later);
  return { add, open, kcal, protein, button, total, note, disabled, later, primary };
}

/** Item the user picked from the server's unit_options: recomputed for that unit, no longer a mismatch, confirmed. */
export function pickUnit(it: Item, o: { qty: number; unit: string }): Item {
  const n = withUnit(it, o.qty, o.unit);
  const { unit_options: _u, ...rest } = n;
  return { ...rest, flags: (n.flags ?? []).filter((f) => f !== 'unit_mismatch'), needs_confirmation: false, alternatives: undefined };
}

/** Vague amount (thoda, zyada…): Small / Usual / Large = 0.5x / 1x / 1.5x of the portion read, none pre-selected. */
export const VAGUE_SIZES = [{ key: 'small', label: 'Small', f: 0.5 }, { key: 'usual', label: 'Usual', f: 1 }, { key: 'large', label: 'Large', f: 1.5 }] as const;
const VAGUE_WORDS = ['thoda', 'thodi', 'thode', 'thora', 'thori', 'zyada', 'jyada', 'zada', 'bahut', 'bohot', 'kam', 'little', 'bit', 'lot', 'lots', 'some'];
/** The amount word the user typed: server field if sent (vague_word / vague_text), else found in the text. */
export function vagueWord(it: Item, text = ''): string {
  const r = it as unknown as Record<string, unknown>;
  const w = r.vague_word ?? r.vague_text ?? r.vague_quantity_word;
  if (typeof w === 'string' && w) return w;
  const words = `${text} ${it.matched_text}`.toLowerCase().split(/[^\p{L}]+/u);
  return words.find((x) => VAGUE_WORDS.includes(x)) ?? '';
}
/** One chip: the same item at f x its quantity, numbers recomputed from the table by `scale` (parser.edit). */
export function vagueChoices(it: Item, scale: (it: Item, qty: number) => Item) {
  return VAGUE_SIZES.map((v) => ({ ...v, item: scale(it, Math.round(it.quantity * v.f * 100) / 100) }));
}
/** Picking a size confirms that recomputed item; the vague flag is cleared. */
export function pickVague(c: Item): Item {
  return { ...c, flags: (c.flags ?? []).filter((f) => f !== 'vague_quantity'), needs_confirmation: false, alternatives: undefined };
}
/** Server numbers scaled to a new quantity (table numbers are linear in portion). Grams scale too. */
export function scaleItem(it: Item, qty: number): Item {
  const f = it.quantity > 0 ? qty / it.quantity : 1;
  const r = (x: number) => Math.round(x * f);
  const r1 = (x: number) => Math.round(x * f * 10) / 10;
  return { ...it, quantity: qty, grams: Math.round(it.grams * f), kcal: { low: r(it.kcal.low), best: r(it.kcal.best), high: r(it.kcal.high) },
    protein_g: { low: r1(it.protein_g.low), best: r1(it.protein_g.best), high: r1(it.protein_g.high) }, carbs_g: r1(it.carbs_g), fat_g: r1(it.fat_g) };
}

/** Copy for a save the server refused, keyed on error.code (not the HTTP status). */
export function rejectCopy(code?: string): string {
  if (code === 'variant_required') return 'Pick a type to save this.';
  if (code === 'quantity_required') return 'Pick how much to save this.';
  return 'Couldn’t save this. Check it and try again.';
}
