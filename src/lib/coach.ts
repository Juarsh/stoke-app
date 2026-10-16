// Rules-based v1 coach: 3 Indian picks from our table that fit what's left,
// favouring protein, respecting diet, never exceeding remaining kcal.
import type { Dish } from '../parser/parser';
import type { Diet } from './domain';

export interface Suggestion { dish: Dish; qty: number; kcal: number; protein: number; label: string }
const allowed: Record<Diet, Set<string>> = { veg: new Set(['veg']), egg: new Set(['veg', 'egg']), nonveg: new Set(['veg', 'egg', 'nonveg']) };
const SKIP = new Set(['condiment', 'drink', 'sweet']);

export function suggest(dishes: Dish[], kcalLeft: number, proteinLeft: number, diet: Diet, n = 3): Suggestion[] {
  if (kcalLeft < 80) return [];
  const out: Suggestion[] = [];
  for (const d of dishes) {
    if (!allowed[diet].has(d.diet ?? 'veg') || SKIP.has(d.category ?? '') || d.kcal <= 0) continue;
    const qty = d.unit === 'count' ? Math.max(1, Math.min(3, Math.floor(kcalLeft / d.kcal))) : 1;
    const kcal = Math.round(d.kcal * qty), protein = Math.round(d.protein_g * qty * 10) / 10;
    if (kcal > kcalLeft) continue; // never push over target
    out.push({ dish: d, qty, kcal, protein, label: `${qty} ${d.unit === 'count' ? '' : d.unit + ' '}${d.name}`.replace(/\s+/g, ' ') });
  }
  const score = (s: Suggestion) => (proteinLeft > 0 ? Math.min(s.protein, proteinLeft) / Math.max(s.kcal, 1) : 0) * 1000 + s.kcal / kcalLeft;
  out.sort((a, b) => score(b) - score(a) || a.dish.id.localeCompare(b.dish.id));
  const seenCat = new Set<string>(); const pick: Suggestion[] = [];
  for (const s of out) { const c = s.dish.category ?? ''; if (seenCat.has(c)) continue; seenCat.add(c); pick.push(s); if (pick.length === n) break; }
  return pick;
}

/** Coach hero: what's left today. Never negative-protein; kcal over target is reported as `over`, not a warning. */
export interface LeftForToday { kcalLeft: number; kcalOver: number; proteinLeft: number; proteinMet: boolean; over: boolean }
export function leftForToday(kcalTarget: number, proteinTarget: number, kcalLogged: number, proteinLogged: number): LeftForToday {
  const k = Math.round(kcalTarget - kcalLogged);
  const p = Math.round((proteinTarget - proteinLogged) * 10) / 10;
  return { kcalLeft: Math.max(0, k), kcalOver: Math.max(0, -k), over: k < 0, proteinLeft: Math.max(0, p), proteinMet: p <= 0 };
}

/** Over-budget variant: lighter picks (<= 150 kcal), highest protein per kcal, diet respected. */
export function lighterPicks(dishes: Dish[], diet: Diet, n = 3): Suggestion[] {
  const out: Suggestion[] = [];
  for (const d of dishes) {
    if (!allowed[diet].has(d.diet ?? 'veg') || SKIP.has(d.category ?? '') || d.kcal <= 0 || d.kcal > 150) continue;
    out.push({ dish: d, qty: 1, kcal: Math.round(d.kcal), protein: Math.round(d.protein_g * 10) / 10, label: `1 ${d.unit === 'count' ? '' : d.unit + ' '}${d.name}`.replace(/\s+/g, ' ') });
  }
  out.sort((a, b) => b.protein / b.kcal - a.protein / a.kcal || a.dish.id.localeCompare(b.dish.id));
  const seen = new Set<string>(); const pick: Suggestion[] = [];
  for (const s of out) { const c = s.dish.category ?? ''; if (seen.has(c)) continue; seen.add(c); pick.push(s); if (pick.length === n) break; }
  return pick;
}

/**
 * One-tap Log safety (hard gate: never a silently wrong number): a pick is logged straight away only if the
 * parser reads its label back as exactly one confident table item for the same dish with the same kcal.
 * Otherwise returns null and the caller opens Log prefilled so the user sees and confirms it.
 */
export function pickItem<I extends { dish_id: string; kcal: { best: number } }>(s: Suggestion, parse: (text: string) => { items: I[]; unmatched: string[] }, ok: (it: I) => boolean): I | null {
  const r = parse(s.label);
  if (r.items.length !== 1 || r.unmatched.length) return null;
  const it = r.items[0];
  if (it.dish_id !== s.dish.id || !ok(it) || Math.abs(Math.round(it.kcal.best) - s.kcal) > 1) return null;
  return it;
}

/** Coach picks: fit-what's-left picks, or lighter picks when at/over target. */
export function coachPicks(dishes: Dish[], kcalLeft: number, proteinLeft: number, diet: Diet, n = 3): Suggestion[] {
  dishes = dishes.filter((d) => !d.needs_verification); // one-tap saves only from verified table rows
  return kcalLeft >= 80 ? suggest(dishes, kcalLeft, proteinLeft, diet, n) : lighterPicks(dishes, diet, n);
}

/** Pick row portion text: '2 pieces', '1 katori'. */
export const portionOf = (p: Suggestion) => (p.dish.unit === 'count' ? `${p.qty} ${p.qty === 1 ? 'piece' : 'pieces'}` : `${p.qty} ${p.dish.unit}`);
