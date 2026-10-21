// Home (build-plan item 3, spec §3): pure numbers for the Food card, the Last 7 days strip and the Coach tip.
// Hard gate: every number is the sum of the counted rows (dayTotals / countedNums), the same rule as the rest of the app.
import { coachPicks, Suggestion } from '@/lib/coach';
import { addDays, counted, dayTotals, Diet, displayName, eatenAt, FoodEntry } from '@/lib/domain';
import type { Dish } from '@/parser/parser';

const IST = 'Asia/Kolkata';

/** Home's date line for the log day ("Wednesday 21 Oct"): from 00:00 to 03:59 that is still the previous day (4 AM start). */
export const homeDate = (date: string) => new Date(`${date}T12:00:00+05:30`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: IST }).replace(',', '');

/** Food card: eaten, left (never negative) or over, protein against target, bar fractions clamped 0..1. */
export function foodCard(dayEntries: FoodEntry[], kcalTarget: number, proteinTarget: number) {
  const tot = dayTotals(dayEntries);
  const diff = Math.round(kcalTarget - tot.kcal);
  return {
    eaten: tot.kcal, protein: tot.protein, kcalTarget, proteinTarget,
    left: Math.max(0, diff), over: Math.max(0, -diff), isOver: diff < 0,
    kcalPct: kcalTarget > 0 ? Math.min(1, tot.kcal / kcalTarget) : 0,
    proteinPct: proteinTarget > 0 ? Math.min(1, tot.protein / proteinTarget) : 0,
  };
}

/** "Last: 1:15 PM · 3 roti, rajma, rice": the latest counted row by eaten-at time (§4, §12.3; not when it was logged) and the
 * rows eaten within 45 min before it. */
export function lastLine(dayEntries: FoodEntry[]): string | null {
  const rows = dayEntries.filter(counted).sort((a, b) => Date.parse(eatenAt(a)) - Date.parse(eatenAt(b)));
  if (!rows.length) return null;
  const last = rows[rows.length - 1]; const end = Date.parse(eatenAt(last));
  const block = rows.filter((e) => end - Date.parse(eatenAt(e)) <= 45 * 60_000);
  const time = new Date(end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: IST });
  const names = [...new Set(block.map((e) => displayName(e.custom_name || '', e.dish_id)))];
  return `Last: ${time} · ${names.join(', ')}`;
}

export type DayState = 'on' | 'over' | 'none' | 'today';
export interface StripDay { date: string; label: string; kcal: number; state: DayState; pct: number }
/** Last 7 days, oldest first, ending today. Days before the first logged day are left out (a new user sees only Today).
 * A past day is "on target" when something was counted and the total is at or under the target, "over" above it,
 * "none" when nothing was counted. Today is always "today" with its fill so far. */
export function weekStrip(all: FoodEntry[], today: string, kcalTarget: number) {
  const byDay = new Map<string, FoodEntry[]>();
  for (const e of all) if (counted(e)) (byDay.get(e.local_date) ?? byDay.set(e.local_date, []).get(e.local_date)!).push(e);
  const first = [...byDay.keys()].sort()[0];
  const days: StripDay[] = [];
  for (let i = 6; i >= 0; i--) {
    const date = addDays(today, -i);
    if (i > 0 && (!first || date < first)) continue;
    const kcal = byDay.has(date) ? dayTotals(byDay.get(date)!).kcal : 0;
    const label = i === 0 ? 'Today' : new Date(date + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
    const state: DayState = i === 0 ? 'today' : !byDay.has(date) ? 'none' : kcal > kcalTarget ? 'over' : 'on';
    days.push({ date, label, kcal, state, pct: kcalTarget > 0 ? Math.min(1, kcal / kcalTarget) : 0 });
  }
  const past = days.filter((d) => d.state !== 'today');
  return { days, onTarget: past.filter((d) => d.state === 'on').length, pastDays: past.length };
}

/** Coach tip (static rules, no AI). Picks come from the verified dish table (coachPicks); units read "bowl", not "katori". */
export function coachTip(o: { eaten: number; kcalLeft: number; over: number; proteinLeft: number; kcalTarget: number; proteinTarget: number; diet: Diet; dishes: Dish[] }): string {
  const fmt = (n: number) => Math.round(n).toLocaleString('en-IN');
  const say = (p: Suggestion) => p.label.replace(/\bkatori\b/g, 'bowl');
  if (o.eaten <= 0) return `your goal is ${fmt(o.kcalTarget)} kcal and ${fmt(o.proteinTarget)} g protein a day. Ask me anything about food or training.`;
  if (o.over > 0) {
    const p = coachPicks(o.dishes, 0, o.proteinLeft, o.diet, 1)[0];
    return `you're ${fmt(o.over)} kcal over today.${p ? ` If you're still hungry, ${say(p)} is about ${p.kcal} kcal.` : ''}`;
  }
  const p = coachPicks(o.dishes, o.kcalLeft, o.proteinLeft, o.diet, 1)[0];
  if (o.proteinLeft >= 10 && p) return `you're ${fmt(o.proteinLeft)} g short on protein. ${cap(say(p))} adds about ${Math.round(p.protein)} g.`;
  if (o.proteinLeft >= 10) return `you're ${fmt(o.proteinLeft)} g short on protein today.`;
  return o.kcalLeft > 0 ? `protein is covered. ${fmt(o.kcalLeft)} kcal left today.` : `you're right on target today.`;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
