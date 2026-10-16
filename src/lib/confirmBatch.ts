// Confirm batch (design-notes "Confirm batch and inline estimates", v3.2 Oct 15).
// WHO DECIDES: the server marks one-tap-confirmable items with `one_tap_ok: true`. The app never derives it from
// flags; a missing field means false. As a CEO guard the app still refuses it for unit_mismatch items (unit_options),
// AI estimates and estimate_unverified items, even if the server sends true.
// Unconfirmed items are left out of every total; all kcal come from the API item (or its unit_options).
import type { Item } from '../parser';
import { withUnit } from './decision';

export type ServerItem = Item & { one_tap_ok?: boolean };
export type Kind = 'counted' | 'batch' | 'unit' | 'estimate' | 'unverified' | 'choice';
const n = (x: number) => Math.round(x).toLocaleString('en-IN');

export const isUnverified = (it: Item) => (it.flags ?? []).includes('estimate_unverified');
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
    .filter((o) => o.dish_id && o.name && Number.isFinite(o.kcal) && o.kcal > 0).map((o) => ({ ...o, protein_g: Number.isFinite(o.protein_g) ? o.protein_g : 0 }));
}
export const isVariantChoice = (it: Item) => (it.flags ?? []).includes('variant_choice') || variantOptions(it).length > 0;
export const isVague = (it: Item) => (it.flags ?? []).includes('vague_quantity');
/** The user picked a type: that variant's server numbers (portion already applied), confirmed, no longer a choice. */
export function pickVariant(it: Item, o: VariantOption): Item {
  const r = { ...(it as unknown as Record<string, unknown>) };
  delete r.variant_options; delete r.variants; delete r.variant_choices;
  const k = Math.round(o.kcal), p = Math.round(o.protein_g * 10) / 10;
  return { ...(r as unknown as Item), dish_id: o.dish_id, name: o.name, kcal: { low: k, best: k, high: k }, protein_g: { low: p, best: p, high: p },
    flags: (it.flags ?? []).filter((f) => f !== 'variant_choice'), needs_confirmation: false, alternatives: undefined, unit_options: undefined };
}
export const isAiEstimate = (it: Item) => it.ai_estimate || it.source === 'ai_estimate';

/** Server field only (missing = false), with the guard: never unit_mismatch, AI estimate or estimate_unverified. */
export function oneTapOk(it: ServerItem): boolean {
  if (it.one_tap_ok !== true) return false;
  return !isUnitMismatch(it) && !isAiEstimate(it) && !isUnverified(it) && !isVariantChoice(it) && !isVague(it);
}

/** confirmed = the user already chose/confirmed this row in the app. */
export function kindOf(it: ServerItem, confirmed: boolean): Kind {
  if (confirmed) return 'counted';
  if (isUnitMismatch(it) || isVariantChoice(it)) return 'unit'; // variant choice reuses the unit-mismatch open row
  if (isUnverified(it)) return 'unverified';
  if (isAiEstimate(it)) return 'estimate';
  if (!it.needs_confirmation && !isVague(it)) return 'counted'; // vague amounts always need a confirm
  return oneTapOk(it) ? 'batch' : 'choice';
}

export type Row = { key: string; it: ServerItem; confirmed: boolean };
/** estimating = AI rows still estimating (not counted, no buttons, skipped by the batch). */
/** waiting = failed AI rows with no kcal yet: they count as items that still need a choice. */
export function plan(rows: Row[], estimating = 0, waiting = 0) {
  const add = rows.filter((r) => { const k = kindOf(r.it, r.confirmed); return k === 'counted' || k === 'batch'; });
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
