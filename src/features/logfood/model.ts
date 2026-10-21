// Log food S2.1 (spec §4, §5): search first, item sheet units / stepper / edits, tray, "Log N items" with a time.
// Pure functions only: every number comes from the bundled dish table via parser.recompute (no new values), and the
// entries go through the store's existing hard gate (entryRefusal) before anything is saved.
import { DISH_TABLE_VERSION, Dish, DISHES, Item, parser } from '@/parser';
import { dayOf, DAY_START_HOUR, entryFromItem, entryRefusal, FoodEntry, istParts, localDate, slotFor, addDays } from '@/lib/domain';

export type UiUnit = 'piece' | 'bowl' | 'g' | 'ml';
/** Q13: the stepper's step per unit; the minimum is one step (− is disabled there). */
export const STEP: Record<UiUnit, number> = { piece: 1, bowl: 0.5, g: 25, ml: 50 };

export const isDrink = (d: Dish) => d.category === 'drink';
/** "tandoori roti" -> "Tandoori roti" */
export const displayName = (d: Pick<Dish, 'name'>) => (d.name ? d.name[0].toUpperCase() + d.name.slice(1) : d.name);

/** Only foods the table can save exactly: no generic (needs_confirm) or unverified-estimate rows (Q3: no AI rows in
 * search). needs_verification rows (rice, egg, milk) stay: picking one by name here is the user's own pick. */
function searchable(d: Dish): boolean {
  return !d.needs_confirm && !d.estimate_unverified && uiUnits(d).length > 0;
}

/** The table unit a UI unit is saved in. ml is saved in grams (1 ml = 1 g for drinks). */
function serverUnit(d: Dish, u: UiUnit): string {
  const su = parser.supportedUnits(d.id);
  if (u === 'piece') return su.includes('count') ? 'count' : 'piece';
  if (u === 'bowl') return 'katori';
  return 'gram';
}
/** §5.3 / Q4: only piece, bowl, g and ml. The default comes first, g last; drinks also have ml. */
export function uiUnits(d: Dish): UiUnit[] {
  const su = parser.supportedUnits(d.id);
  // §5.3 example: Chai "ml · g". Drinks are ml and g only.
  if (isDrink(d)) return su.includes('gram') ? ['ml', 'g'] : [];
  const has: UiUnit[] = [];
  if (su.includes('count') || su.includes('piece')) has.push('piece');
  if (su.includes('katori')) has.push('bowl');
  if (su.includes('gram')) has.push('g');
  const def = preferredUnit(d);
  return has.includes(def) ? [def, ...has.filter((u) => u !== def)] : has;
}
function preferredUnit(d: Dish): UiUnit {
  if (isDrink(d)) return 'ml';
  if (d.unit === 'count' || d.unit === 'piece') return 'piece';
  if (d.unit === 'katori') return 'bowl';
  return 'g';
}
export const defaultUnit = (d: Dish): UiUnit => uiUnits(d)[0];
/** The food's default portion in a unit: 1 piece / 1 bowl, or the table's portion grams (ml for drinks). */
export function defaultAmount(d: Dish, u: UiUnit): number {
  return u === 'piece' || u === 'bowl' ? 1 : Math.max(1, Math.round(d.portion_grams));
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** Search ranking: exact name, name prefix, exact alias, a word prefix, alias prefix, contains; then shorter names. */
export function rank(d: Dish, q: string): number | null {
  const n = norm(d.name), al = (d.aliases ?? []).map(norm);
  const words = n.split(' ');
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  if (al.includes(q)) return 2;
  if (words.some((w) => w.startsWith(q))) return 3;
  if (al.some((a) => a.startsWith(q) || a.split(' ').some((w) => w.startsWith(q)))) return 4;
  if (n.includes(q)) return 5;
  const qt = q.split(' ');
  if (qt.length > 1 && qt.every((t) => words.some((w) => w.startsWith(t)) || al.some((a) => a.split(' ').some((w) => w.startsWith(t))))) return 6;
  return null;
}
export function searchFoods(query: string, table: Dish[] = DISHES, limit = 20): Dish[] {
  const q = norm(query);
  if (!q) return [];
  const hits: { d: Dish; r: number }[] = [];
  for (const d of table) { const r = rank(d, q); if (r !== null && searchable(d)) hits.push({ d, r }); }
  hits.sort((a, b) => a.r - b.r || a.d.name.length - b.d.name.length || a.d.name.localeCompare(b.d.name));
  return hits.slice(0, limit).map((h) => h.d);
}
/** Recent: the last table foods logged (newest first, one row each), still in the table and searchable. */
export function recentFoods(entries: FoodEntry[], limit = 4): Dish[] {
  const seen = new Set<string>(); const out: Dish[] = [];
  for (const e of [...entries].filter((x) => !x.deleted_at && x.dish_id).sort((a, b) => (b.eaten_at ?? b.created_at).localeCompare(a.eaten_at ?? a.created_at))) {
    const d = parser.dishById(e.dish_id!);
    if (!d || seen.has(d.id) || !searchable(d)) continue;
    seen.add(d.id); out.push(d);
    if (out.length >= limit) break;
  }
  return out;
}

// ---------- the item sheet / tray rows ----------
/** A tray row. Edited values are kept per gram, so they scale with the amount and the unit and keep their mark. */
export interface TrayItem { key: string; dishId: string; unit: UiUnit; amount: number; kcalPerG?: number; proteinPerG?: number }
export interface Computed { name: string; kcal: number; protein: number; carbs: number; fat: number; grams: number; item: Item; kcalEdited: boolean; proteinEdited: boolean }

const r1 = (x: number) => Math.round(x * 10) / 10;
export function newTrayItem(d: Dish, key: string, unit: UiUnit = defaultUnit(d), amount = defaultAmount(d, unit)): TrayItem {
  return { key, dishId: d.id, unit, amount };
}
export function compute(t: TrayItem): Computed {
  const d = parser.dishById(t.dishId)!;
  const it = parser.recompute(d.id, t.amount, serverUnit(d, t.unit), d.oil_sensitive ? 'normal' : '');
  const grams = it.grams;
  const kcalEdited = typeof t.kcalPerG === 'number', proteinEdited = typeof t.proteinPerG === 'number';
  return {
    name: displayName(d), grams, item: it, kcalEdited, proteinEdited,
    kcal: kcalEdited ? Math.round(t.kcalPerG! * grams) : it.kcal.best,
    protein: proteinEdited ? r1(t.proteinPerG! * grams) : it.protein_g.best,
    carbs: it.carbs_g ?? 0, fat: it.fat_g ?? 0,
  };
}
/** Typed amount / stepper value: > 0 and at most 5000 (the table's quantity range). */
export const amountOk = (n: number) => Number.isFinite(n) && n > 0 && n <= 5000;
export const canStepDown = (t: Pick<TrayItem, 'unit' | 'amount'>) => t.amount - STEP[t.unit] >= STEP[t.unit] - 1e-9;
export function stepAmount(t: TrayItem, dir: 1 | -1): TrayItem {
  const s = STEP[t.unit];
  if (dir < 0 && !canStepDown(t)) return t;
  const next = Math.round((t.amount + dir * s) / s) * s; // snaps a typed 1.3 to the step grid
  return { ...t, amount: Math.min(5000, Math.max(s, next === t.amount ? t.amount + dir * s : next)) };
}
export function setUnit(t: TrayItem, u: UiUnit): TrayItem {
  if (u === t.unit) return t;
  const d = parser.dishById(t.dishId)!;
  return { ...t, unit: u, amount: defaultAmount(d, u) };
}
/** Typed kcal / protein: kept exactly at this amount (and scaled with it after). null clears (Reset). */
export function editKcal(t: TrayItem, kcal: number | null): TrayItem {
  if (kcal === null) { const { kcalPerG: _k, ...rest } = t; return rest; }
  return { ...t, kcalPerG: kcal / compute(t).grams };
}
export function editProtein(t: TrayItem, p: number | null): TrayItem {
  if (p === null) { const { proteinPerG: _p, ...rest } = t; return rest; }
  return { ...t, proteinPerG: p / compute(t).grams };
}
export const resetEdits = (t: TrayItem): TrayItem => editProtein(editKcal(t, null), null);
export const isEdited = (t: TrayItem) => typeof t.kcalPerG === 'number' || typeof t.proteinPerG === 'number';

/** Quick + : the default amount; a food already in the tray (same unit) gets it added to its row. */
export function quickAdd(tray: TrayItem[], d: Dish, key: string): TrayItem[] {
  const u = defaultUnit(d), add = defaultAmount(d, u);
  const i = tray.findIndex((x) => x.dishId === d.id && x.unit === u);
  if (i < 0) return [...tray, newTrayItem(d, key, u, add)];
  return tray.map((x, j) => (j === i ? { ...x, amount: Math.min(5000, x.amount + add) } : x));
}
/** "×N" for a food in the tray: its amount in default portions (at least 1). */
export function trayCount(tray: TrayItem[], d: Dish): number {
  let n = 0;
  for (const x of tray) if (x.dishId === d.id) n += Math.max(1, Math.round(x.amount / defaultAmount(d, x.unit)));
  return n;
}
/** Tray total: the exact sum of the rows (rounded once, like the day totals). */
export function trayTotal(tray: TrayItem[]): { kcal: number; protein: number } {
  let k = 0, p = 0;
  for (const t of tray) { const c = compute(t); k += c.kcal; p += c.protein; }
  return { kcal: Math.round(k), protein: r1(p) };
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const fmtN = (n: number) => (Number.isInteger(n) ? String(n) : n === 0.5 ? '½' : Number.isInteger(n - 0.5) ? `${Math.floor(n)}½` : String(r1(n)));
/** "1 piece", "2 pieces", "1½ bowls", "150 g", "250 ml" */
export function amountLabel(u: UiUnit, n: number): string {
  if (u === 'piece') return `${fmtN(n)} ${plural(n, 'piece', 'pieces')}`;
  if (u === 'bowl') return `${fmtN(n)} ${n <= 1 ? 'bowl' : 'bowls'}`;
  return `${fmtN(n)} ${u}`;
}
export const unitA11y = (u: UiUnit) => (u === 'g' ? 'grams' : u === 'ml' ? 'millilitres' : u === 'piece' ? 'pieces' : 'bowls');
export const logLabel = (n: number, kcal: number) => `Log ${n} ${plural(n, 'item', 'items')} · ${kcal.toLocaleString('en-IN')} kcal`;

// ---------- time (spec §4) ----------
export type TimePick = { kind: 'now' } | { kind: 'ago'; min: 30 | 60 } | { kind: 'at'; iso: string };
export const FUTURE_REASON = 'That time hasn’t happened yet.';
export const TOO_OLD_REASON = 'Pick a time in the last 7 days.';
export const MAX_BACK_DAYS = 7;
export function pickTime(p: TimePick, now: Date): Date {
  return p.kind === 'now' ? now : p.kind === 'ago' ? new Date(now.getTime() - p.min * 60000) : new Date(p.iso);
}
export function timeReason(at: Date, now: Date): string | null {
  if (at.getTime() > now.getTime() + 60000) return FUTURE_REASON;
  if (at.getTime() < now.getTime() - MAX_BACK_DAYS * 86400000) return TOO_OLD_REASON;
  return null;
}
/** IST "7:45 PM" */
export function clock(d: Date): string {
  const x = new Date(d.getTime() + 330 * 60000);
  const h = x.getUTCHours(), m = x.getUTCMinutes();
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const weekday = (date: string) => WD[new Date(date + 'T00:00:00Z').getUTCDay()];
/** Q31: "Now ▾"; else "7:45 PM ▾" for the current log day, "Yesterday 7:45 PM ▾", or "Mon 7:45 PM ▾". */
export function chipLabel(p: TimePick, now: Date, dayStartHour = DAY_START_HOUR): string {
  if (p.kind === 'now') return 'Now';
  const at = pickTime(p, now), day = dayOf(at, dayStartHour), today = dayOf(now, dayStartHour);
  const pre = day === today ? '' : day === addDays(today, -1) ? 'Yesterday ' : `${weekday(day)} `;
  return `${pre}${clock(at)}`;
}
/** The wheel's days: the calendar dates (IST) from today back 7 days, newest last ("Tue 20"). */
export function wheelDays(now: Date): { date: string; label: string }[] {
  const today = localDate(now);
  return Array.from({ length: MAX_BACK_DAYS + 1 }, (_, i) => addDays(today, i - MAX_BACK_DAYS))
    .map((date) => ({ date, label: `${weekday(date)} ${Number(date.slice(8))}` }));
}
export const dateLong = (date: string) => `${weekday(date)} ${Number(date.slice(8))} ${MON[Number(date.slice(5, 7)) - 1]}`;
/** A wheel reading (calendar date, 1–12, minute, AM/PM) as a moment (IST). */
export function wheelTime(date: string, h12: number, minute: number, pm: boolean): Date {
  const h = (h12 % 12) + (pm ? 12 : 0);
  return new Date(Date.parse(`${date}T${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+05:30`));
}
export function wheelOf(d: Date): { date: string; h12: number; minute: number; pm: boolean } {
  const p = istParts(d), m = new Date(d.getTime() + 330 * 60000).getUTCMinutes();
  return { date: localDate(d), h12: p.hour % 12 || 12, minute: Math.floor(m / 5) * 5, pm: p.hour >= 12 };
}
export const dayStartLine = (dayStartHour = DAY_START_HOUR) =>
  `The day starts at ${dayStartHour} AM, so ${dayStartHour > 1 ? 1 : 0} AM counts towards the day before.`;

// ---------- Log ----------
/** "Log N items": N entries at the chosen time, or the reasons none can be saved (all-or-nothing, §5.2). */
export function buildEntries(tray: TrayItem[], at: Date, o: { now?: Date; newId: () => string; dayStartHour?: number }):
  { entries: FoodEntry[]; refused: { key: string; reason: string }[] } {
  const now = o.now ?? new Date();
  const local_date = dayOf(at, o.dayStartHour ?? DAY_START_HOUR), slot = slotFor(at);
  const entries: FoodEntry[] = [], refused: { key: string; reason: string }[] = [];
  for (const t of tray) {
    const c = compute(t), d = parser.dishById(t.dishId)!;
    const variant = parser.variantGroup(d.id) ? { variant_dish_id: d.id } : {}; // the user picked this exact food
    const base = entryFromItem({ ...c.item, ...variant } as Item, { slot, raw_text: c.name, local_date, tableVersion: DISH_TABLE_VERSION, now, id: o.newId() });
    const snap = { eaten_at: at.toISOString(), display_amount: t.amount, display_unit: t.unit, grams: c.grams };
    let e: FoodEntry = { ...base, ...snap };
    if (c.kcalEdited || c.proteinEdited) {
      // typed numbers are the user's own (custom on the server): saved exactly as typed, flagged, never recomputed
      const k = c.kcal, p = c.protein;
      e = { ...e, dish_id: null, custom_name: c.name, source: 'custom', item_source: undefined, variant_dish_id: undefined,
        kcal: { low: k, best: k, high: k }, protein_g: { low: p, best: p, high: p },
        ...(c.kcalEdited ? { kcal_edited: true } : {}), ...(c.proteinEdited ? { protein_edited: true } : {}) };
    }
    const why = entryRefusal(e);
    if (why) refused.push({ key: t.key, reason: why });
    entries.push(e);
  }
  return refused.length ? { entries: [], refused } : { entries, refused };
}
