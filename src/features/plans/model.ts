// Plans and weekly split (build-plan item 9, spec §2 vocabulary, CEO Q1; full-b2 train / plan-builder / plan-builder-delete /
// home / home-empty / states #8; workouts 2-weekly-split-empty). Pure rules only: the shapes kept on the phone, the starter
// templates, today's workout from the 4 AM log day (dayOf in domain.ts), the split rows, labels, and the save checks.
// Plan = the weekly split; Routine = one day inside it (Push A); Workout = a logged session (item 10+).
import type { ExerciseRepo } from '@/lib/exercises';

export interface Target { sets: number; repsLow: number; repsHigh: number }
export interface RoutineExercise { exercise_id: string; target: Target | null; rest_s: number }
export interface Routine { id: string; name: string; exercises: RoutineExercise[] }
/** days[0..6] = Mon..Sun: a routine id from this plan, or null for a rest day. */
export interface Plan { id: string; name: string; days: (string | null)[]; routines: Routine[]; created_at: string; updated_at: string }
export interface PlansState { v: 1; plans: Plan[]; activeId: string | null }
export const EMPTY_PLANS: PlansState = { v: 1, plans: [], activeId: null };

/** Limits for a target and rest (steppers stop here; save refuses anything outside, never clamps silently). */
export const LIMITS = { sets: [1, 10], reps: [1, 50], rest: [0, 600], restStep: 15, name: 30, exercises: 20 } as const;
export const DEFAULT_REST = 90;
export const DEFAULT_TARGET: Target = { sets: 3, repsLow: 10, repsHigh: 10 };

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const WEEKDAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
/** Mon = 0 … Sun = 6 for a log day (YYYY-MM-DD from dayOf; never the wall clock, so 1 AM Wednesday is still Tuesday). */
export const weekdayOf = (date: string) => (new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7;

// ---- labels -------------------------------------------------------------------------------------------------
export const targetLabel = (t: Target | null) => (t ? `${t.sets} × ${t.repsLow === t.repsHigh ? t.repsLow : `${t.repsLow}–${t.repsHigh}`}` : null);
export const targetA11y = (t: Target | null) => (t ? `${t.sets} sets of ${t.repsLow === t.repsHigh ? t.repsLow : `${t.repsLow} to ${t.repsHigh}`} reps` : 'No target');
export const restLabel = (s: number) => (s <= 0 ? 'no rest' : `rest ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
/** "~55 min": every set (the target's, or 3 without one) takes ~45 s plus the exercise's rest; rounded to 5 min. */
export function estMinutes(r: Routine): number {
  const s = r.exercises.reduce((sum, x) => sum + (x.target?.sets ?? 3) * (45 + x.rest_s), 0);
  return r.exercises.length ? Math.max(5, Math.round(s / 300) * 5) : 0;
}
export const countLabel = (n: number) => `${n} ${n === 1 ? 'exercise' : 'exercises'}`;
/** "Deadlift, Lat Pulldown +4" (Home shows 2 names, Train 3). */
export function namesLine(r: Routine, repo: ExerciseRepo, show: number): string {
  const names = r.exercises.map((x) => repo.byId(x.exercise_id)?.name ?? 'Exercise');
  return names.slice(0, show).join(', ') + (names.length > show ? ` +${names.length - show}` : '');
}
/** The weekday chip on the routine page: "Mondays", "Mon, Fri", or "Not in your week". */
export function daysLabel(plan: Plan, routineId: string): string {
  const on = plan.days.map((d, i) => (d === routineId ? i : -1)).filter((i) => i >= 0);
  if (!on.length) return 'Not in your week';
  return on.length === 1 ? `${WEEKDAYS_LONG[on[0]]}s` : on.map((i) => WEEKDAYS[i]).join(', ');
}
export const trainingDays = (p: Plan) => p.days.filter((d) => d && p.routines.some((r) => r.id === d)).length;
export const daysCount = (p: Plan) => { const n = trainingDays(p); return `${n} ${n === 1 ? 'day' : 'days'}`; };

// ---- today -----------------------------------------------------------------------------------------------------
export type Today =
  | { kind: 'none' }
  | { kind: 'routine'; plan: Plan; routine: Routine; weekday: number }
  | { kind: 'rest'; plan: Plan; next: { routine: Routine; weekday: number; inDays: number } | null };
export const activePlan = (s: PlansState) => s.plans.find((p) => p.id === s.activeId) ?? null;
export function todayWorkout(s: PlansState, date: string): Today {
  const plan = activePlan(s);
  if (!plan) return { kind: 'none' };
  const wd = weekdayOf(date);
  const at = (i: number) => { const id = plan.days[i % 7]; return id ? plan.routines.find((r) => r.id === id) ?? null : null; };
  const r = at(wd);
  if (r) return { kind: 'routine', plan, routine: r, weekday: wd };
  for (let k = 1; k <= 7; k++) { const n = at(wd + k); if (n) return { kind: 'rest', plan, next: { routine: n, weekday: (wd + k) % 7, inDays: k } }; }
  return { kind: 'rest', plan, next: null };
}
/** "Next: Push B tomorrow" / "Next: Push B on Fri". */
export const nextLine = (n: { routine: Routine; weekday: number; inDays: number } | null) =>
  !n ? 'No workouts in this plan yet.' : `Next: ${n.routine.name} ${n.inDays === 1 ? 'tomorrow' : `on ${WEEKDAYS[n.weekday]}`}`;

export interface SplitRow { weekday: number; label: string; routine: Routine | null; today: boolean }
export function splitRows(plan: Plan, date: string): SplitRow[] {
  const wd = weekdayOf(date);
  return WEEKDAYS.map((label, i) => ({ weekday: i, label, today: i === wd, routine: plan.routines.find((r) => r.id === plan.days[i]) ?? null }));
}

// ---- editing -------------------------------------------------------------------------------------------------
export const stamp = (p: Plan, now: string): Plan => ({ ...p, updated_at: now });
export function upsertRoutine(p: Plan, r: Routine): Plan {
  return { ...p, routines: p.routines.some((x) => x.id === r.id) ? p.routines.map((x) => (x.id === r.id ? r : x)) : [...p.routines, r] };
}
/** Delete a routine: it comes off every day of the split (those days become rest). Past workouts are not touched. */
export const removeRoutine = (p: Plan, id: string): Plan => ({ ...p, routines: p.routines.filter((r) => r.id !== id), days: p.days.map((d) => (d === id ? null : d)) });
export const setDay = (p: Plan, weekday: number, routineId: string | null): Plan => ({ ...p, days: p.days.map((d, i) => (i === weekday ? routineId : d)) });
export function move<T>(xs: T[], from: number, to: number): T[] {
  if (to < 0 || to >= xs.length || from === to) return xs;
  const out = [...xs]; const [x] = out.splice(from, 1); out.splice(to, 0, x); return out;
}
/** Steppers: one step, stopping at the limits (the button is disabled there, Q13 style). */
export const step = (v: number, d: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v + d));
/** Reps steppers keep low ≤ high: raising low past high raises high with it; lowering high under low lowers low. */
export function stepReps(t: Target, which: 'low' | 'high', d: number): Target {
  if (which === 'low') { const lo = step(t.repsLow, d, LIMITS.reps); return { ...t, repsLow: lo, repsHigh: Math.max(lo, t.repsHigh) }; }
  const hi = step(t.repsHigh, d, LIMITS.reps); return { ...t, repsHigh: hi, repsLow: Math.min(hi, t.repsLow) };
}
/** "Push A" → "Push A (2)" when the plan already has that name (case-insensitive). */
export function uniqueName(name: string, taken: string[]): string {
  const has = (n: string) => taken.some((x) => x.trim().toLowerCase() === n.toLowerCase());
  if (!has(name)) return name;
  for (let i = 2; ; i++) if (!has(`${name} (${i})`)) return `${name} (${i})`;
}

// ---- save checks (hard gate: refuse with a reason, never save a wrong or clamped value) ---------------------------
const int = (n: unknown, [lo, hi]: readonly [number, number]) => typeof n === 'number' && Number.isInteger(n) && n >= lo && n <= hi;
export function routineError(r: Routine, repo: ExerciseRepo, otherNames: string[] = []): string | null {
  const name = r.name.trim();
  if (!name) return 'Give this routine a name.';
  if (name.length > LIMITS.name) return `Keep the name to ${LIMITS.name} characters.`;
  if (otherNames.some((n) => n.trim().toLowerCase() === name.toLowerCase())) return `This plan already has a routine called ${name}.`;
  if (!r.exercises.length) return 'Add at least one exercise.';
  if (r.exercises.length > LIMITS.exercises) return `A routine can have up to ${LIMITS.exercises} exercises.`;
  for (const x of r.exercises) {
    const e = repo.byId(x.exercise_id);
    if (!e) return 'One exercise isn’t in the library any more. Remove it to save.';
    if (!int(x.rest_s, LIMITS.rest) || x.rest_s % LIMITS.restStep) return `Check the rest time for ${e.name}.`;
    if (x.target && (!int(x.target.sets, LIMITS.sets) || !int(x.target.repsLow, LIMITS.reps) || !int(x.target.repsHigh, LIMITS.reps) || x.target.repsLow > x.target.repsHigh))
      return `Check the target for ${e.name}.`;
  }
  return null;
}
export function planError(p: Plan, repo: ExerciseRepo): string | null {
  const name = p.name.trim();
  if (!name) return 'Give this plan a name.';
  if (name.length > 40) return 'Keep the plan name to 40 characters.';
  if (p.days.length !== 7) return 'A plan has 7 days.';
  if (p.days.some((d) => d !== null && !p.routines.some((r) => r.id === d))) return 'One day points to a routine that isn’t in this plan.';
  for (const r of p.routines) { const e = routineError(r, repo, p.routines.filter((x) => x.id !== r.id).map((x) => x.name)); if (e) return `${r.name || 'A routine'}: ${e}`; }
  return null;
}
/** What the phone loads: anything that isn't a plans state is ignored. A plan is kept as saved even if a later library
 * update removed one of its exercises (the routine page then says so); nothing is dropped or rewritten here. */
export function parsePlans(raw: string | null): PlansState {
  if (!raw) return EMPTY_PLANS;
  try {
    const s = JSON.parse(raw);
    if (!s || s.v !== 1 || !Array.isArray(s.plans)) return EMPTY_PLANS;
    const plans = (s.plans as Plan[]).filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string' && Array.isArray(p.routines) && Array.isArray(p.days) && p.days.length === 7
      && p.routines.every((r) => r && typeof r.id === 'string' && Array.isArray(r.exercises)));
    return { v: 1, plans, activeId: plans.some((p) => p.id === s.activeId) ? s.activeId : null };
  } catch { return EMPTY_PLANS; }
}

// ---- templates (the empty state: PPL / Upper-Lower / Full body) --------------------------------------------------
type Ex = [id: string, target: [sets: number, low: number, high?: number] | null, rest: number];
const R = (name: string, xs: Ex[]) => ({ name, xs });
const PUSH_A = R('Push A', [['wger-73', [4, 6, 8], 150], ['wger-1893', [3, 8], 120], ['wger-537', null, 90], ['wger-1689', null, 60], ['wger-348', [3, 15], 60], ['wger-1900', null, 60]]);
const PULL_A = R('Pull A', [['wger-184', [3, 5], 180], ['wger-158', [3, 10], 120], ['wger-1117', [3, 10], 90], ['wger-1732', [3, 15], 60], ['wger-272', [3, 10], 60], ['wger-91', [3, 10], 60]]);
const LEGS_A = R('Legs A', [['wger-1801', [4, 6, 8], 180], ['wger-1700', [3, 8], 150], ['wger-374', [3, 10], 120], ['wger-365', [3, 12], 60], ['wger-369', [3, 12], 60], ['wger-148', [3, 15], 60]]);
const PUSH_B = R('Push B', [['wger-567', [4, 8], 120], ['wger-75', [3, 10], 120], ['wger-308', [3, 12], 60], ['wger-1378', [3, 15], 60], ['wger-197', [3, 10], 90]]);
const PULL_B = R('Pull B', [['wger-475', [3, 8], 120], ['wger-1698', [4, 8], 120], ['wger-81', [3, 10], 90], ['wger-822', [3, 15], 60], ['wger-92', [3, 10], 60]]);
const UPPER_A = R('Upper A', [['wger-73', [4, 6, 8], 150], ['wger-1698', [4, 8], 120], ['wger-567', [3, 10], 90], ['wger-158', [3, 10], 90], ['wger-92', [2, 12], 60], ['wger-1900', [2, 12], 60]]);
const LOWER_A = R('Lower A', [['wger-1801', [4, 6, 8], 180], ['wger-1700', [3, 8], 150], ['wger-365', [3, 12], 60], ['wger-148', [3, 15], 60], ['wger-167', [3, 15], 60]]);
const UPPER_B = R('Upper B', [['wger-1893', [4, 6, 8], 150], ['wger-475', [3, 8], 120], ['wger-537', [3, 10], 90], ['wger-1117', [3, 10], 90], ['wger-348', [3, 15], 60], ['wger-272', [2, 12], 60]]);
const LOWER_B = R('Lower B', [['wger-184', [3, 5], 180], ['wger-374', [3, 10], 120], ['wger-206', [3, 10], 90], ['wger-369', [3, 12], 60], ['wger-458', null, 60]]);
const FULL_A = R('Full body A', [['wger-1801', [3, 8], 150], ['wger-73', [3, 8], 150], ['wger-1698', [3, 8], 120], ['wger-567', [2, 10], 90], ['wger-458', null, 60]]);
const FULL_B = R('Full body B', [['wger-184', [3, 5], 180], ['wger-1893', [3, 8], 120], ['wger-158', [3, 10], 90], ['wger-203', [3, 10], 90], ['wger-167', [3, 15], 60]]);
type Tpl = { key: string; name: string; sub: string; popular?: boolean; week: (ReturnType<typeof R> | null)[] };
export const TEMPLATES: Tpl[] = [
  { key: 'ppl', name: 'Push · Pull · Legs', sub: '5 days · Mon Push, Tue Pull, Wed Legs…', popular: true, week: [PUSH_A, PULL_A, LEGS_A, null, PUSH_B, PULL_B, null] },
  { key: 'ul', name: 'Upper · Lower', sub: '4 days · good for beginners', week: [UPPER_A, LOWER_A, null, UPPER_B, LOWER_B, null, null] },
  { key: 'fb', name: 'Full body', sub: '3 days · Mon, Wed, Fri', week: [FULL_A, null, FULL_B, null, FULL_A, null, null] },
];
/** A new plan from a template: one routine per distinct template day (Full body A sits on Mon and Fri). */
export function fromTemplate(key: string, newId: () => string, now: string, taken: string[] = []): Plan {
  const t = TEMPLATES.find((x) => x.key === key);
  if (!t) throw new Error(`no template ${key}`);
  const ids = new Map<string, string>(); const routines: Routine[] = [];
  for (const d of t.week) if (d && !ids.has(d.name)) {
    const id = newId(); ids.set(d.name, id);
    routines.push({ id, name: d.name, exercises: d.xs.map(([exercise_id, tg, rest_s]) => ({ exercise_id, rest_s, target: tg ? { sets: tg[0], repsLow: tg[1], repsHigh: tg[2] ?? tg[1] } : null })) });
  }
  return { id: newId(), name: uniqueName(t.name, taken), days: t.week.map((d) => (d ? ids.get(d.name)! : null)), routines, created_at: now, updated_at: now };
}
export const blankPlan = (newId: () => string, now: string, taken: string[] = []): Plan =>
  ({ id: newId(), name: uniqueName('My plan', taken), days: [null, null, null, null, null, null, null], routines: [], created_at: now, updated_at: now });
