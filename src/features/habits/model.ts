// Habits (build-plan items 13–14; spec §7, §8, §10, §12.4–12.5, CEO Q7/Q9/Q14/Q16/Q17/Q19/Q20/Q21/Q25).
// Pure model: habits and their daily logs, which habits are due on a log day (from dayOf, 4 AM start), the Home B2 order,
// the streak (one silent free miss per Mon–Sun week), the short-name rule (auto-derive, 74dp fit at 1.3×, uniqueness),
// and the save checks. A bad value is refused with a reason, never clamped. Exercise linking is cut from v1 (CEO, M3).
import { addDays } from '@/lib/domain';
import { weekdayOf } from '../plans/model';
import { DM_BOLD_EM, DM_BOLD_FALLBACK_EM } from './fontWidths';

export type HabitKind = 'done' | 'count' | 'sets';
export type Schedule = 'daily' | 'weekdays' | 'days';
export interface Habit {
  id: string; name: string; short_name: string; short_name_auto: boolean; icon: string | null;
  kind: HabitKind;
  /** count: the number per day and its unit ("8 glasses") */
  target_value: number | null; unit: string | null;
  /** sets: "3 × 15" */
  target_sets: number | null; target_reps: number | null;
  schedule: Schedule; /** Mon = bit 0 … Sun = bit 6 */ weekdays: number;
  starts_on: string; position: number; archived_at: string | null; created_at: string; updated_at: string;
}
export interface TargetSnap { kind: HabitKind; value: number | null; unit: string | null; sets: number | null; reps: number | null }
export interface HabitLog {
  id: string; habit_id: string; local_date: string;
  /** count: amount; sets: sets done; done: null */
  value: number | null; done: boolean; target_snapshot: TargetSnap; logged_at: string;
}
export interface HabitsState { v: 1; habits: Habit[]; logs: HabitLog[] }
export const EMPTY_HABITS: HabitsState = { v: 1, habits: [], logs: [] };

export const LIMITS = { name: 40, short: 16, count: [1, 999], sets: [1, 20], reps: [1, 200], unit: 16, lateDays: 7 } as const;
export const UNITS = ['glasses', 'pages', 'minutes', 'times', 'km', 'litres', 'servings'] as const;
export const ALL_DAYS = 0b1111111, WEEKDAYS_MASK = 0b0011111;
export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

// ---- due days -----------------------------------------------------------------------------------------------
export const maskOf = (h: Pick<Habit, 'schedule' | 'weekdays'>) => (h.schedule === 'daily' ? ALL_DAYS : h.schedule === 'weekdays' ? WEEKDAYS_MASK : h.weekdays);
export const isDue = (h: Habit, date: string) => !h.archived_at && date >= h.starts_on && (maskOf(h) & (1 << weekdayOf(date))) !== 0;
export const active = (s: HabitsState) => s.habits.filter((h) => !h.archived_at).sort((a, b) => a.position - b.position);
/** Today's visible habits in the user's order (off-day habits aren't shown or counted; no show-from in v1, Q16). */
export const dueToday = (s: HabitsState, date: string) => active(s).filter((h) => isDue(h, date));
export const logOf = (s: HabitsState, id: string, date: string) => s.logs.find((l) => l.habit_id === id && l.local_date === date) ?? null;
export const isDoneOn = (s: HabitsState, id: string, date: string) => !!logOf(s, id, date)?.done;
export const snapOf = (h: Habit): TargetSnap => ({ kind: h.kind, value: h.target_value, unit: h.unit, sets: h.target_sets, reps: h.target_reps });
/** the full amount one tap logs */
export const fullValue = (t: TargetSnap) => (t.kind === 'count' ? t.value : t.kind === 'sets' ? t.sets : null);

// ---- Home B2 order (§7.2) -----------------------------------------------------------------------------------
/** Undone first in the user's order (partial counts as undone), then done, most recently done first. */
export function homeOrder(s: HabitsState, date: string): string[] {
  const hs = dueToday(s, date);
  const undone = hs.filter((h) => !isDoneOn(s, h.id, date));
  const done = hs.filter((h) => isDoneOn(s, h.id, date)).sort((a, b) => (logOf(s, b.id, date)!.logged_at).localeCompare(logOf(s, a.id, date)!.logged_at));
  return [...undone, ...done].map((h) => h.id);
}
export interface HomeRow { kind: 'none' | 'all-done' | 'row'; ids: string[]; more: number; total: number }
/** 3 slots + More ("+N" = today's visible habits not shown); fewer than 3 share the row; none → "+ Add habit"; all done → "All N done". */
export function homeRow(s: HabitsState, date: string, order: string[] = homeOrder(s, date)): HomeRow {
  const due = new Set(dueToday(s, date).map((h) => h.id));
  const ids = order.filter((id) => due.has(id));
  if (!ids.length) return { kind: 'none', ids: [], more: 0, total: 0 };
  if (ids.every((id) => isDoneOn(s, id, date))) return { kind: 'all-done', ids: [], more: 0, total: ids.length };
  return { kind: 'row', ids: ids.slice(0, 3), more: Math.max(0, ids.length - 3), total: ids.length };
}
/** Habits screen order (§10.1): not done first in the user's order, done at the end (user order). */
export function listOrder(s: HabitsState, date: string): Habit[] {
  const hs = dueToday(s, date);
  return [...hs.filter((h) => !isDoneOn(s, h.id, date)), ...hs.filter((h) => isDoneOn(s, h.id, date))];
}

// ---- labels ---------------------------------------------------------------------------------------------------
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** "8 glasses", "3 × 15", null for yes / no */
export function targetText(t: TargetSnap): string | null {
  if (t.kind === 'count') return `${t.value} ${t.unit ?? ''}`.trim();
  if (t.kind === 'sets') return `${t.sets} × ${t.reps}`;
  return null;
}
/** detail meta: "3 sets × 15 reps · Every day", "8 glasses · Weekdays", "Mon, Wed, Fri" */
export function daysText(h: Pick<Habit, 'schedule' | 'weekdays'>): string {
  if (h.schedule === 'daily') return 'Every day';
  if (h.schedule === 'weekdays') return 'Weekdays';
  const days = DAY_NAMES.filter((_, i) => h.weekdays & (1 << i));
  return days.length === 7 ? 'Every day' : days.join(', ');
}
export function metaLine(h: Habit): string {
  const t = h.kind === 'sets' ? `${plural(h.target_sets ?? 0, 'set', 'sets')} × ${plural(h.target_reps ?? 0, 'rep', 'reps')}` : targetText(snapOf(h));
  return t ? `${t} · ${daysText(h)}` : daysText(h);
}
/** partial amounts are text, never a fill (§10.4): "5 of 8 glasses", "2 of 3 sets" */
export function partialText(l: HabitLog | null): string | null {
  if (!l || l.done || l.value === null) return null;
  const t = l.target_snapshot;
  return t.kind === 'count' ? `${l.value} of ${t.value} ${t.unit ?? ''}`.trim() : t.kind === 'sets' ? `${l.value} of ${t.sets} sets` : null;
}
export const daysCount = (n: number) => plural(n, 'day', 'days');
/** TalkBack, §7.4: "Push-ups, Incline push-ups 3 by 12, not done. Double-tap to mark done" / "Water, done" */
export function homeA11y(h: Habit, done: boolean): string {
  if (done) return `${h.short_name}, done`;
  const t = targetText(snapOf(h));
  return `${h.short_name}, ${h.name}${t ? ` ${t.replace(' × ', ' by ')}` : ''}, not done. Double-tap to mark done`;
}

// ---- streak (§10.3) ---------------------------------------------------------------------------------------------
/** Consecutive due days done, back from today (today counts once done; not done yet doesn't break it). Days not due are
 *  skipped. One miss per Mon–Sun week is forgiven silently; a second miss in the same week ends the streak. */
export function streak(s: HabitsState, h: Habit, today: string): number {
  const done = new Set(s.logs.filter((l) => l.habit_id === h.id && l.done).map((l) => l.local_date));
  let n = 0; const missedWeek = new Set<string>();
  for (let d = today, i = 0; d >= h.starts_on && i < 3700; d = addDays(d, -1), i++) {
    if (!(maskOf(h) & (1 << weekdayOf(d)))) continue;
    if (done.has(d)) { n++; continue; }
    if (d === today) continue;
    const wk = addDays(d, -weekdayOf(d));
    if (missedWeek.has(wk)) break;
    missedWeek.add(wk);
  }
  return n;
}
export type DayCell = 'done' | 'missed' | 'today' | 'future' | 'before' | 'off';
/** This week, Mon–Sun: done (sage ✓), today (outlined), future (faded dashed), missed (warm grey), before start (dash), off. */
export function weekCells(s: HabitsState, h: Habit, today: string): { date: string; cell: DayCell; isToday: boolean }[] {
  const mon = addDays(today, -weekdayOf(today));
  return DAY_NAMES.map((_, i) => {
    const date = addDays(mon, i); const isToday = date === today;
    const cell: DayCell = date < h.starts_on ? 'before' : isDoneOn(s, h.id, date) ? 'done' : date > today ? 'future'
      : !(maskOf(h) & (1 << i)) ? 'off' : isToday ? 'today' : 'missed';
    return { date, cell, isToday };
  });
}
/** Late logging (Q14): today and the 7 days before it. */
export function logDateError(date: string, today: string): string | null {
  if (date > today) return 'You can’t log a day that hasn’t started.';
  if (date < addDays(today, -LIMITS.lateDays)) return 'You can log up to 7 days back.';
  return null;
}

// ---- short name (§8) ---------------------------------------------------------------------------------------------
export const HOME_SLOT_DP = 74, LARGE_SP = 19.5;
export const textWidth = (s: string, sp: number) => [...s].reduce((a, c) => a + (DM_BOLD_EM[c] ?? DM_BOLD_FALLBACK_EM), 0) * sp;
/** pieces a name may break into: at spaces, and after a hyphen ("Push-" "ups") */
export const pieces = (s: string) => s.split(/\s+/).filter(Boolean).flatMap((w) => { const p = w.split('-'); return p.map((x, i) => (i < p.length - 1 ? `${x}-` : x)).filter((x) => x && x !== '-'); });
/** §8.4: every piece must fit the 74dp slot at 1.3× (19.5sp). Returns the first piece that doesn't. */
export const tooWide = (short: string) => pieces(short).find((p) => textWidth(p, LARGE_SP) > HOME_SLOT_DP) ?? null;
/** Runtime fallback (§8.4) for names saved before the check or text above 1.3×: a hyphen inside a word, never clipping. */
export function hyphenate(short: string, sp: number, slot = HOME_SLOT_DP): string {
  return short.split(' ').map((w) => {
    if (textWidth(w.split('-').sort((a, b) => b.length - a.length)[0], sp) <= slot) return w;
    let out = '', cur = '';
    for (const c of w) { if (cur && textWidth(cur + c + '-', sp) > slot) { out += cur + '-\n'; cur = ''; } cur += c; }
    return out + cur;
  }).join(' ');
}
const UNIT_WORDS = 'glasses?|glass|ml|l|litres?|liters?|min|mins|minutes?|hrs?|hours?|pages?|km|steps?|sets?|reps?|times?|x|cups?|servings?';
const SCHEDULE = /\b(daily|every\s*day|everyday|on\s+weekends?|weekends?|weekdays?|mornings?|in\s+the\s+morning|at\s+night|nightly|evenings?)\b/gi;
const KEYWORDS: { re: RegExp; short: string; icon: string }[] = [
  { re: /push[\s-]?ups?/i, short: 'Push-ups', icon: 'train' },
  { re: /\bwater\b/i, short: 'Water', icon: 'drop' },
  { re: /\bread(ing)?\b/i, short: 'Read', icon: 'book' },
  { re: /\bwalk(s|ing)?\b/i, short: 'Walk', icon: 'walk' },
  { re: /\brun(s|ning)?\b|\bjog/i, short: 'Run', icon: 'walk' },
  { re: /\bstretch/i, short: 'Stretch', icon: 'leaf' },
  // "Meditate" is 87dp at 1.3× and "Vitamin" 75dp, so their keyword names are shorter (§8.2 build-time check)
  { re: /\bmeditat/i, short: 'Calm', icon: 'leaf' },
  { re: /\bsleep/i, short: 'Sleep', icon: 'moon' },
  { re: /\bjournal/i, short: 'Journal', icon: 'pencil' },
  { re: /\bvitamin|\bsupplement|\bpills?\b/i, short: 'Pills', icon: 'pill' },
];
export const KEYWORD_SHORTS = KEYWORDS.map((k) => k.short).concat('Call');
const cap = (w: string) => (w ? w[0].toUpperCase() + w.slice(1) : w);
/** §8.2: the suggested short name and icon (null icon = monogram). weak = suggested with the field highlighted. */
export function deriveShort(name: string): { short: string; icon: string | null; weak: boolean } {
  const raw = name.trim();
  if (!raw) return { short: '', icon: null, weak: false };
  for (const k of KEYWORDS) if (k.re.test(raw)) return { short: k.short, icon: k.icon, weak: false };
  const clean = raw.replace(SCHEDULE, ' ').replace(/\d+([.,]\d+)?\s*[×x]\s*\d+/gi, ' ').replace(new RegExp(`\\d+([.,]\\d+)?\\s*(${UNIT_WORDS})?\\b`, 'gi'), ' ')
    .replace(new RegExp(`\\b(${UNIT_WORDS})\\b`, 'gi'), ' ').replace(/[×]/g, ' ').replace(/[0-9!-,./:-@[-`{-~]/g, (c) => (c === '-' || c === "'" ? c : ' ')).replace(/\s+/g, ' ').trim();
  const words = clean.split(' ').filter(Boolean);
  const call = /^call\b/i.test(clean);
  if (call) {
    const two = words.length > 1 ? `Call ${words[1]}` : 'Call';
    return two.length <= LIMITS.short && !tooWide(two) && words.length > 1 && !/^(grand|parents|family|friends)/i.test(words[1])
      ? { short: two, icon: 'phone', weak: false } : { short: 'Call', icon: 'phone', weak: true };
  }
  let short = '';
  for (const w of words) {
    const next = short ? `${short} ${w}` : cap(w);
    if (next.length > LIMITS.short || tooWide(next)) break;
    short = next;
  }
  if (!short) {
    const first = (words[0] ?? raw.split(/\s+/)[0] ?? '').slice(0, LIMITS.short);
    return { short: cap(first), icon: null, weak: true };
  }
  return { short, icon: null, weak: false };
}
/** the monogram fallback: "C" for Call mom */
export const monogram = (h: Pick<Habit, 'short_name' | 'name'>) => (h.short_name || h.name).trim().charAt(0).toUpperCase() || '?';
/** Q21: case-insensitive, ignoring spaces and hyphens, exact match only */
export const shortKey = (s: string) => s.toLowerCase().replace(/[\s-]+/g, '');

// ---- save checks (§8.1, §8.3, §8.4, §10.2) ---------------------------------------------------------------------
export interface Draft {
  name: string; short_name: string; short_name_auto: boolean; icon: string | null; kind: HabitKind;
  target_value: number; unit: string; target_sets: number; target_reps: number; schedule: Schedule; weekdays: number;
}
export const blankDraft = (): Draft => ({ name: '', short_name: '', short_name_auto: true, icon: null, kind: 'done', target_value: 8, unit: 'glasses', target_sets: 3, target_reps: 12, schedule: 'daily', weekdays: ALL_DAYS });
export const draftOf = (h: Habit): Draft => ({ name: h.name, short_name: h.short_name, short_name_auto: h.short_name_auto, icon: h.icon, kind: h.kind,
  target_value: h.target_value ?? 8, unit: h.unit ?? 'glasses', target_sets: h.target_sets ?? 3, target_reps: h.target_reps ?? 12, schedule: h.schedule, weekdays: h.weekdays });
const intIn = (v: number, [lo, hi]: readonly [number, number]) => Number.isInteger(v) && v >= lo && v <= hi;
export type DraftErrors = Partial<Record<'name' | 'short' | 'target' | 'days', string>>;
export function draftErrors(d: Draft, others: Habit[]): DraftErrors {
  const e: DraftErrors = {};
  const name = d.name.trim(), short = d.short_name.trim();
  if (!name) e.name = 'Enter a name.';
  else if (name.length > LIMITS.name) e.name = `Name can be at most ${LIMITS.name} characters.`;
  if (!short) e.short = 'Enter a short name for Home.';
  else if (short.length > LIMITS.short) e.short = `Short name can be at most ${LIMITS.short} characters.`;
  else if (tooWide(short)) e.short = 'Too long for Home. Try a shorter name.';
  else if (others.some((h) => !h.archived_at && shortKey(h.short_name) === shortKey(short))) e.short = 'Already used, pick another';
  if (d.kind === 'count') {
    if (!intIn(d.target_value, LIMITS.count)) e.target = `Target must be a whole number from 1 to ${LIMITS.count[1]}.`;
    else if (!d.unit.trim() || d.unit.trim().length > LIMITS.unit) e.target = 'Pick a unit.';
    else if (/^steps?$/i.test(d.unit.trim())) e.target = 'Steps are on the Food card, so they can’t be a habit.';
  }
  if (d.kind === 'sets' && (!intIn(d.target_sets, LIMITS.sets) || !intIn(d.target_reps, LIMITS.reps))) e.target = `Sets must be 1 to ${LIMITS.sets[1]} and reps 1 to ${LIMITS.reps[1]}.`;
  if (d.schedule === 'days' && !(d.weekdays & ALL_DAYS)) e.days = 'Pick at least one day.';
  return e;
}
export const firstError = (e: DraftErrors) => e.name ?? e.short ?? e.target ?? e.days ?? null;
/** a checked draft as habit fields (target fields only for the chosen type) */
export function fromDraft(d: Draft): Pick<Habit, 'name' | 'short_name' | 'short_name_auto' | 'icon' | 'kind' | 'target_value' | 'unit' | 'target_sets' | 'target_reps' | 'schedule' | 'weekdays'> {
  return {
    name: d.name.trim(), short_name: d.short_name.trim(), short_name_auto: d.short_name_auto, icon: d.icon, kind: d.kind,
    target_value: d.kind === 'count' ? d.target_value : null, unit: d.kind === 'count' ? d.unit.trim() : null,
    target_sets: d.kind === 'sets' ? d.target_sets : null, target_reps: d.kind === 'sets' ? d.target_reps : null,
    schedule: d.schedule, weekdays: d.schedule === 'days' ? d.weekdays & ALL_DAYS : maskOf(d),
  };
}

// ---- loading ---------------------------------------------------------------------------------------------------
export function parseHabits(raw: string | null): HabitsState {
  if (!raw) return EMPTY_HABITS;
  try {
    const o = JSON.parse(raw);
    if (!o || o.v !== 1 || !Array.isArray(o.habits) || !Array.isArray(o.logs)) return EMPTY_HABITS;
    const habits = o.habits.filter((h: Habit) => h && typeof h.id === 'string' && typeof h.name === 'string' && typeof h.short_name === 'string' && typeof h.starts_on === 'string');
    const ids = new Set(habits.map((h: Habit) => h.id));
    return { v: 1, habits, logs: o.logs.filter((l: HabitLog) => l && ids.has(l.habit_id) && typeof l.local_date === 'string' && l.target_snapshot) };
  } catch { return EMPTY_HABITS; }
}
