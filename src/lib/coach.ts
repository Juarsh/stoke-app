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
