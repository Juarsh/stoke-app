// Pure domain logic (no React / native imports) so it is unit-testable.
import type { Item, OilLevel, Range } from '../parser/parser';

export type Slot = 'breakfast' | 'lunch' | 'snacks' | 'dinner';
export type Diet = 'veg' | 'egg' | 'nonveg';
export type Goal = 'lose' | 'gain' | 'maintain';
export type EntrySource = 'table' | 'ai' | 'manual' | 'custom';

export interface Profile {
  goal: Goal; sex: 'm' | 'f'; age: number; heightCm: number; weightKg: number;
  activity: 'sedentary' | 'light' | 'moderate' | 'active'; diet: Diet;
  kcalTarget: number; proteinTarget: number; stepsTarget: number; addStepKcal: boolean; showKcalOnCards: boolean;
}

/**
 * A saved food entry. Numbers are a SNAPSHOT taken at save time and are never
 * recalculated on sync or when the dish table updates; dish_table_version
 * records which table produced them. Only an explicit user edit changes them.
 */
export interface FoodEntry {
  id: string; local_date: string; slot: Slot; raw_text: string;
  dish_id: string | null; custom_name: string; qty: number; unit: string; oil_level: OilLevel;
  kcal: Range; protein_g: Range; carbs_g?: number; fat_g?: number; source: EntrySource; item_source?: string; source_note: string; confirmed: boolean;
  dish_table_version: number; created_at: string; updated_at: string; deleted_at: string | null;
  /** parse span (matched_text). Sent as ItemIn.span when remember=true, so the backend stores it as a Remembered food. */
  span?: string; remember?: boolean;
}

export const ACTIVITY: Record<Profile['activity'], number> = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725 };

/** Mifflin-St Jeor; lose -400, gain +300 (spec: ±300–500); protein 1.6 g/kg (lose/gain) or 1.2 (maintain). */
export function computeTargets(p: Pick<Profile, 'goal' | 'sex' | 'age' | 'heightCm' | 'weightKg' | 'activity'>) {
  const bmr = 10 * p.weightKg + 6.25 * p.heightCm - 5 * p.age + (p.sex === 'm' ? 5 : -161);
  const tdee = bmr * ACTIVITY[p.activity];
  const adj = p.goal === 'lose' ? -400 : p.goal === 'gain' ? 300 : 0;
  const kcal = Math.round((tdee + adj) / 10) * 10;
  const protein = Math.round(p.weightKg * (p.goal === 'maintain' ? 1.2 : 1.6));
  return { kcal: Math.max(1200, kcal), protein };
}

/** Spec: before 11 breakfast, 11–4 lunch, 4–7 snacks, after 7 dinner (IST). */
export function slotFor(d: Date): Slot {
  const h = istParts(d).hour;
  return h < 11 ? 'breakfast' : h < 16 ? 'lunch' : h < 19 ? 'snacks' : 'dinner';
}
const IST_MS = 330 * 60 * 1000;
export function istParts(d: Date) {
  const x = new Date(d.getTime() + IST_MS);
  return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, day: x.getUTCDate(), hour: x.getUTCHours() };
}
export function localDate(d: Date = new Date()): string {
  const p = istParts(d);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
export function addDays(date: string, n: number): string {
  const t = Date.parse(date + 'T00:00:00Z') + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
/** Monday of the ISO week containing date (weeks run Mon–Sun IST). */
export function weekStart(date: string): string {
  const dow = (new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7;
  return addDays(date, -dow);
}

export interface StreakState { current: number; best: number; frozenDays: string[]; lastLogged: string | null; freezeJustUsed: boolean }
/**
 * Streak with one AUTOMATIC freeze per Mon–Sun week. A single missed day is
 * covered if that week's freeze is unused; unused freezes don't carry over.
 * `today` not yet logged doesn't break the streak.
 */
export function computeStreak(loggedDates: Iterable<string>, today: string): StreakState {
  const logged = new Set(loggedDates);
  const sorted = [...logged].sort();
  if (sorted.length === 0) return { current: 0, best: 0, frozenDays: [], lastLogged: null, freezeJustUsed: false };
  let best = 0, run = 0, prev: string | null = null;
  const usedWeeks = new Set<string>();
  let frozen: string[] = [];
  const end = logged.has(today) ? today : addDays(today, -1);
  for (let d = sorted[0]; d <= end; d = addDays(d, 1)) {
    if (logged.has(d)) { run++; prev = d; }
    else if (run > 0 && !usedWeeks.has(weekStart(d)) && logged.has(addDays(d, 1)) ) { usedWeeks.add(weekStart(d)); frozen.push(d); }
    else if (run > 0 && !usedWeeks.has(weekStart(d)) && d === end) { usedWeeks.add(weekStart(d)); frozen.push(d); }
    else { run = 0; frozen = []; }
    best = Math.max(best, run);
  }
  const yesterday = addDays(today, -1);
  return { current: run, best, frozenDays: frozen, lastLogged: prev, freezeJustUsed: frozen.includes(yesterday) || frozen.includes(addDays(today, -2)) };
}

/** Build an immutable entry snapshot from a parsed (or edited) item. */
export function entryFromItem(it: Item, o: { slot: Slot; raw_text: string; local_date: string; tableVersion: number; now?: Date; id: string; remember?: boolean }): FoodEntry {
  const now = (o.now ?? new Date()).toISOString();
  return {
    id: o.id, local_date: o.local_date, slot: o.slot, raw_text: o.raw_text,
    dish_id: it.ai_estimate ? null : it.dish_id, custom_name: it.ai_estimate ? it.name : '',
    qty: it.quantity, unit: it.unit, oil_level: it.oil_level,
    kcal: { ...it.kcal }, protein_g: { ...it.protein_g }, carbs_g: it.carbs_g, fat_g: it.fat_g,
    source: it.ai_estimate ? 'ai' : 'table', item_source: it.source, source_note: it.source_note, confirmed: true,
    dish_table_version: o.tableVersion, created_at: now, updated_at: now, deleted_at: null,
    span: it.matched_text, remember: !!o.remember,
  };
}

export function dayTotals(entries: FoodEntry[]) {
  let kcal = 0, protein = 0;
  for (const e of entries) if (!e.deleted_at) { kcal += e.kcal.best; protein += e.protein_g.best; }
  return { kcal: Math.round(kcal), protein: Math.round(protein * 10) / 10 };
}

/** ~0.04 kcal per step (rough, shown as ≈). */
export const stepsKcal = (steps: number) => Math.round(steps * 0.04);
