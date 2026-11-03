// Widget reads and writes, through the app's one data layer (../lib/data LocalStore) and the habits model's checks.
// While the app is running its habits provider owns the data (liveHabits): a widget tap goes through it, so the screen
// and the store change together and DocSync queues the change. Otherwise (app closed) the stored habits are changed
// with the same pure function and saved; the app reads them on start (and on coming back to the foreground).
import * as Crypto from 'expo-crypto';
import { localStore } from '../lib/data';
import { dayOf } from '../lib/domain';
import { HABITS_KEY, liveHabits } from '../lib/habits';
import { PLANS_KEY } from '../lib/plans';
import { APP_STATE_KEY } from '../lib/store';
import { WORKOUTS_KEY } from '../lib/workouts';
import { addGlassIn, parseHabits, toggleIn, type HabitsState, type LogChange, type LogCtx } from '../features/habits/model';
import { parsePlans, type PlansState } from '../features/plans/model';
import { parseWorkouts, type WorkoutsState } from '../features/workout/model';
import { parseAppSnap, type AppSnap } from './model';

export interface WidgetData { date: string; app: AppSnap; habits: HabitsState; plans: PlansState; workouts: WorkoutsState }
/** everything the widgets show, read fresh from the store; the 4 AM log day of `now` */
export async function loadWidgetData(now = new Date()): Promise<WidgetData> {
  const [app, habits, plans, workouts] = await Promise.all([APP_STATE_KEY, HABITS_KEY, PLANS_KEY, WORKOUTS_KEY].map((k) => localStore.load(k).catch(() => null)));
  const live = liveHabits.current;
  return { date: dayOf(now), app: parseAppSnap(app), habits: live ? live.snapshot() : parseHabits(habits), plans: parsePlans(plans), workouts: parseWorkouts(workouts) };
}

/** one habits change from a widget: refused → the reason (nothing written); done → null */
async function changeHabits(f: (s: HabitsState, c: LogCtx) => LogChange | string, now: Date): Promise<string | null> {
  const c: LogCtx = { today: dayOf(now), nowIso: now.toISOString(), newId: () => Crypto.randomUUID() };
  const live = liveHabits.current;
  if (live) { const r = live.applyChange((s) => f(s, c)); return typeof r === 'string' ? r : null; }
  const s = parseHabits(await localStore.load(HABITS_KEY));
  const r = f(s, c);
  if (typeof r === 'string') return r;
  await localStore.save(HABITS_KEY, JSON.stringify(r.state));
  return null;
}
/** Habits widget: tick (or un-tick) one of today's habits, exactly like one tap on Home */
export const tickHabit = (habitId: string, now = new Date()) => changeHabits((s, c) => toggleIn(s, habitId, c.today, c), now);
/** Water widget: one more glass today */
export const addWater = (now = new Date()) => changeHabits((s, c) => addGlassIn(s, c.today, c), now);
