// Home-screen widgets (Android): what each widget shows, as pure functions of the same local data the app keeps (app
// state, habits, plans, workouts; read through the LocalStore seam in ../lib/data by ./actions). No numbers of their own:
// Today uses dayNumbers (the same function as Home), habits / water use the habits model, workout uses todayWorkout.
import { kc } from '../lib/format';
import { dayNumbers, type FoodEntry, type Profile } from '../lib/domain';
import { dueToday, homeOrder, isDoneOn, streak, waterHabit, waterOn, type HabitsState } from '../features/habits/model';
import { countLabel, todayWorkout, type PlansState, type Routine } from '../features/plans/model';
import type { WorkoutsState } from '../features/workout/model';
import type { ThemePref } from '../theme';

/** The provider names (config plugin in app.config.ts, task handler, refresh). */
export const WIDGETS = { today: 'StokeToday', habits: 'StokeHabits', water: 'StokeWater', workout: 'StokeWorkout' } as const;
export type WidgetName = (typeof WIDGETS)[keyof typeof WIDGETS];
export const WIDGET_NAMES = Object.values(WIDGETS) as WidgetName[];
/** click actions handled in the background (no app open) */
export const ACTIONS = { tickHabit: 'TICK_HABIT', addWater: 'ADD_WATER' } as const;

/** Deep links into the app (the stoke:// scheme; expo-router maps the path to a screen in src/app). */
export const ROUTES = { home: '/', logFood: '/log-food', habits: '/habits', startWorkout: '/start-workout', startEmpty: '/start-workout?empty=1', settings: '/settings', train: '/train', choosePlan: '/choose-plan' } as const;
export const linkOf = (scheme: string, route: string) => `${scheme}://${route.replace(/^\//, '')}`;

/** What the app keeps under its app-state key that the Today widget needs (store.tsx Persisted). */
export interface AppSnap { entries: FoodEntry[]; steps: Record<string, number>; profile: Profile | null; themePref: ThemePref }
export function parseAppSnap(raw: string | null): AppSnap {
  const empty: AppSnap = { entries: [], steps: {}, profile: null, themePref: 'system' };
  if (!raw) return empty;
  try {
    const o = JSON.parse(raw) ?? {};
    return { entries: Array.isArray(o.entries) ? o.entries : [], steps: o.steps && typeof o.steps === 'object' ? o.steps : {}, profile: o.profile ?? null,
      themePref: o.themePref === 'light' || o.themePref === 'dark' ? o.themePref : 'system' };
  } catch { return empty; }
}

export interface TodayView { kind: 'setup' | 'day'; kcal: number; kcalTarget: number; kcalLeft: number; protein: number; proteinTarget: number }
export function todayView(a: AppSnap, date: string): TodayView {
  const n = dayNumbers(a.entries, a.steps, a.profile, date);
  return { kind: a.profile ? 'day' : 'setup', kcal: n.tot.kcal, kcalTarget: n.kcalTarget, kcalLeft: n.kcalLeft, protein: n.tot.protein, proteinTarget: n.proteinTarget };
}
/** "420 left" / "180 over" (never a negative number shown as left); kcal in the app's one format (kc) */
export const leftText = (left: number) => (left >= 0 ? `${kc(left)} left` : `${kc(-left)} over`);

export interface HabitRowView { id: string; name: string; done: boolean; streak: number }
export interface HabitsView { rows: HabitRowView[]; done: number; total: number }
/** today's due habits in the Home order (undone first); `max` rows fit the widget size */
export function habitsView(s: HabitsState, date: string, max: number): HabitsView {
  const due = dueToday(s, date);
  const byId = new Map(due.map((h) => [h.id, h]));
  const rows = homeOrder(s, date).slice(0, Math.max(0, max)).map((id) => { const h = byId.get(id)!; return { id, name: h.short_name, done: isDoneOn(s, id, date), streak: streak(s, h, date) }; });
  return { rows, done: due.filter((h) => isDoneOn(s, h.id, date)).length, total: due.length };
}

export interface WaterView { kind: 'none' | 'water'; name: string; count: number; target: number; unit: string; done: boolean }
export function waterView(s: HabitsState, date: string): WaterView {
  const h = waterHabit(s, date);
  if (!h) return { kind: 'none', name: 'Water', count: 0, target: 0, unit: 'glasses', done: false };
  return { kind: 'water', name: h.short_name, ...waterOn(s, h, date) };
}

export interface WorkoutView { kind: 'active' | 'routine' | 'rest' | 'none'; title: string; sub: string; button: string }
export function workoutView(p: PlansState, w: WorkoutsState, date: string): WorkoutView {
  if (w.active) return { kind: 'active', title: w.active.title, sub: 'Workout in progress', button: 'Resume' };
  const t = todayWorkout(p, date);
  if (t.kind === 'routine') return { kind: 'routine', title: t.routine.name, sub: countLabel(t.routine.exercises.length), button: 'Start workout' };
  if (t.kind === 'rest') return { kind: 'rest', title: 'Rest day', sub: t.next ? `Next: ${t.next.routine.name}` : 'No workouts in this plan yet', button: 'Start anyway' };
  return { kind: 'none', title: 'No plan yet', sub: 'Pick a split like Push · Pull · Legs', button: 'Choose a plan' };
}

/** widget height in dp → the 2x2 layout: a 2x1 is one row of cells (about 40–120 dp by launcher), a 2x2 about 150–230 dp */
export const isTall = (heightDp: number) => heightDp >= 140;

/** what stoke://start-workout does with the data as it is now: resume, start today's routine, start empty (rest day,
 *  only when asked), or open Train */
export type StartTarget = { to: string } & ({ start: 'none' } | { start: 'empty' } | { start: 'routine'; routine: Routine; planId: string });
export function startTarget(p: PlansState, w: WorkoutsState, date: string, emptyOnRest: boolean): StartTarget {
  if (w.active) return { to: '/workout', start: 'none' };
  const t = todayWorkout(p, date);
  if (t.kind === 'routine') return { to: '/workout', start: 'routine', routine: t.routine, planId: t.plan.id };
  if (t.kind === 'rest') return emptyOnRest ? { to: '/workout', start: 'empty' } : { to: '/train', start: 'none' };
  return { to: '/choose-plan', start: 'none' };
}
