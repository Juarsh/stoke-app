// Android home-screen widgets (src/widgets): Today numbers are Home's numbers (dayNumbers), habit ticks and water glasses
// go through the habits model's checks (refused with a reason, never clamped; streak rules unchanged), widget writes land
// in the same store the app reads (app closed) or through the running provider (app open), the app re-reads the store when
// it comes back to the foreground, deep links resolve to real screens, the provider config is 2x1 / 2x2 only, and the
// widgets use the B2 tokens in light and dark.
import fs from 'fs';
import path from 'path';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { AppState } from 'react-native';

jest.mock('../src/lib/config', () => ({ config: { mock: true, mockAi: false, mockAiDelay: 0 }, flags: {}, brand: { scheme: 'stoke' } }));
const mockKv = new Map<string, string>();
jest.mock('../src/lib/kv', () => ({ kv: { get: async (k: string) => mockKv.get(k) ?? null, set: async (k: string, v: string) => { mockKv.set(k, v); } } }));
let mockN = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `id-${++mockN}` }));

import { dayNumbers, dayOf, type FoodEntry, type Profile } from '../src/lib/domain';
import { Habits, HABITS_KEY, HabitsProvider, liveHabits, useHabits } from '../src/lib/habits';
import { APP_STATE_KEY } from '../src/lib/store';
import { PLANS_KEY } from '../src/lib/plans';
import { WORKOUTS_KEY } from '../src/lib/workouts';
import {
  addGlassIn, ALL_DAYS, Habit, HabitLog, HabitsState, parseHabits, setAmountIn, snapOf, streak, toggleIn, waterDraft, draftErrors, type LogCtx,
} from '../src/features/habits/model';
import { EMPTY_PLANS, type Plan, type PlansState } from '../src/features/plans/model';
import { EMPTY_WORKOUTS } from '../src/features/workout/model';
import { addWater, loadWidgetData, tickHabit } from '../src/widgets/actions';
import { ACTIONS, habitsView, isTall, leftText, linkOf, parseAppSnap, ROUTES, startTarget, todayView, waterView, WIDGET_NAMES, WIDGETS, workoutView } from '../src/widgets/model';
import { widgetFor } from '../src/widgets/render';
import { palette } from '../src/theme/tokens';
import { WidgetSync, WIDGET_DEBOUNCE_MS } from '../src/widgets/WidgetSync';
import { StoreProvider } from '../src/lib/store';

const D = '2026-10-21'; // Wednesday
const NOW = new Date(2026, 9, 21, 12, 0, 0); // local noon on D (after the 4 AM day start)
let k = 0;
const H = (p: Partial<Habit> & { short_name: string }): Habit => ({ id: `h${++k}`, name: p.short_name, short_name_auto: true, icon: null, kind: 'done', target_value: null, unit: null,
  target_sets: null, target_reps: null, schedule: 'daily', weekdays: ALL_DAYS, starts_on: '2026-01-01', position: k, archived_at: null, created_at: '', updated_at: '', ...p });
const L = (h: Habit, date: string, p: Partial<HabitLog> = {}): HabitLog => ({ id: `l${++k}`, habit_id: h.id, local_date: date, value: null, done: true,
  target_snapshot: snapOf(h), logged_at: `${date}T10:00:00Z`, ...p });
const S = (habits: Habit[], logs: HabitLog[] = []): HabitsState => ({ v: 1, habits, logs });
const C: LogCtx = { today: D, nowIso: `${D}T06:30:00.000Z`, newId: () => `n${++k}` };
const water = (p: Partial<Habit> = {}) => H({ short_name: 'Water', kind: 'count', target_value: 3, unit: 'glasses', ...p });
const row = (date: string, kcal: number, protein: number, extra: Partial<FoodEntry> = {}): FoodEntry => ({
  id: `e${++k}`, local_date: date, slot: 'lunch', raw_text: '', dish_id: null, custom_name: 'x', qty: 1, unit: 'count', oil_level: '',
  kcal: { low: kcal, best: kcal, high: kcal }, protein_g: { low: protein, best: protein, high: protein }, source: 'table', source_note: '', confirmed: true,
  dish_table_version: 1, created_at: '', updated_at: '', deleted_at: null, ...extra } as FoodEntry);
const PROFILE: Profile = { goal: 'maintain', sex: 'm', age: 30, heightCm: 175, weightKg: 75, activity: 'moderate', diet: 'veg',
  kcalTarget: 2000, proteinTarget: 90, maintenanceKcal: 2633, stepsTarget: 8000, addStepKcal: false, showKcalOnCards: true };

beforeEach(() => { mockKv.clear(); liveHabits.current = null; });

describe('Today widget: the same numbers as Home', () => {
  const entries = [row(D, 500, 20.5), row(D, 300, 10), row(D, 900, 30, { needs_review: true }), row(D, 200, 5, { deleted_at: 'x' }), row('2026-10-20', 999, 99)];
  test('counted entries of the log day only; targets from the profile; equals dayNumbers (what useDay shows)', () => {
    const v = todayView({ entries, steps: {}, profile: PROFILE, themePref: 'system' }, D);
    const n = dayNumbers(entries, {}, PROFILE, D);
    expect(v).toEqual({ kind: 'day', kcal: 800, kcalTarget: 2000, kcalLeft: 1200, protein: 30.5, proteinTarget: 90 });
    expect([v.kcal, v.protein, v.kcalTarget, v.kcalLeft]).toEqual([n.tot.kcal, n.tot.protein, n.kcalTarget, n.kcalLeft]);
  });
  test('step kcal added to the budget only when the profile says so', () => {
    expect(todayView({ entries, steps: { [D]: 5000 }, profile: { ...PROFILE, addStepKcal: true }, themePref: 'system' }, D).kcalTarget).toBe(2200);
    expect(todayView({ entries, steps: { [D]: 5000 }, profile: PROFILE, themePref: 'system' }, D).kcalTarget).toBe(2000);
  });
  test('over target says over (never a negative "left"); no profile → setup', () => {
    expect(leftText(-180)).toBe('180 over'); expect(leftText(1200)).toBe('1,200 left');
    expect(todayView(parseAppSnap(null), D).kind).toBe('setup');
    expect(parseAppSnap('not json')).toEqual(parseAppSnap(null));
  });
  test('reads the app state the store saved', async () => {
    mockKv.set(APP_STATE_KEY, JSON.stringify({ entries, steps: {}, profile: PROFILE, themePref: 'dark', queue: [] }));
    const d = await loadWidgetData(NOW);
    expect(d.date).toBe(dayOf(NOW));
    expect(todayView(d.app, d.date).kcal).toBe(800);
    expect(d.app.themePref).toBe('dark');
  });
});

describe('habit tick: the same change as one tap on Home', () => {
  test('toggleIn ticks at the full target and un-ticks a done day', () => {
    const a = H({ short_name: 'Read' }), w = water();
    const s = S([a, w]);
    const r1 = toggleIn(s, a.id, D, C) as { state: HabitsState };
    expect(r1.state.logs).toEqual([expect.objectContaining({ habit_id: a.id, local_date: D, done: true, value: null })]);
    const r2 = toggleIn(r1.state, a.id, D, C) as { state: HabitsState };
    expect(r2.state.logs).toEqual([]);
    const r3 = toggleIn(s, w.id, D, C) as { state: HabitsState };
    expect(r3.state.logs[0]).toEqual(expect.objectContaining({ done: true, value: 3 }));
  });
  test('refused with a reason, nothing changed: deleted habit, a day not started, more than 7 days back', () => {
    const a = H({ short_name: 'Read' });
    expect(toggleIn(S([a]), 'gone', D, C)).toBe('This habit was deleted.');
    expect(toggleIn(S([a]), a.id, '2026-10-22', C)).toBe('You can’t log a day that hasn’t started.');
    expect(toggleIn(S([a]), a.id, '2026-10-10', C)).toBe('You can log up to 7 days back.');
    expect(setAmountIn(S([water()]), water().id, D, 9, C)).toMatch(/deleted|whole number/);
  });
  test('a bad amount is refused, never clamped', () => {
    const w = water();
    expect(setAmountIn(S([w]), w.id, D, 4, C)).toBe('Enter a whole number from 0 to 3.');
    expect(setAmountIn(S([w]), w.id, D, 1.5, C)).toBe('Enter a whole number from 0 to 3.');
    expect(setAmountIn(S([w]), w.id, D, -1, C)).toBe('Enter a whole number from 0 to 3.');
  });
  test('streak: a widget tick counts exactly like an app tick (and the free miss rule still holds)', () => {
    const a = H({ short_name: 'Read' });
    const logs = ['2026-10-18', '2026-10-19', '2026-10-20'].map((d) => L(a, d));
    const before = S([a], logs);
    expect(streak(before, a, D)).toBe(3); // today not done yet doesn't break it
    const after = (toggleIn(before, a.id, D, C) as { state: HabitsState }).state;
    expect(streak(after, a, D)).toBe(4);
    const undone = (toggleIn(after, a.id, D, C) as { state: HabitsState }).state;
    expect(streak(undone, a, D)).toBe(3);
  });
  test('app closed: tickHabit changes the stored habits; a refusal writes nothing', async () => {
    const a = H({ short_name: 'Read' });
    mockKv.set(HABITS_KEY, JSON.stringify(S([a])));
    expect(await tickHabit(a.id, NOW)).toBeNull();
    const s = parseHabits(mockKv.get(HABITS_KEY)!);
    expect(s.logs).toEqual([expect.objectContaining({ habit_id: a.id, local_date: dayOf(NOW), done: true })]);
    const raw = mockKv.get(HABITS_KEY);
    expect(await tickHabit('gone', NOW)).toBe('This habit was deleted.');
    expect(mockKv.get(HABITS_KEY)).toBe(raw);
  });
  test('habitsView: due habits in the Home order (undone first), done count, streak', () => {
    const a = H({ short_name: 'Read' }), b = H({ short_name: 'Walk' }), off = H({ short_name: 'Gym', schedule: 'days', weekdays: 0b1000000 });
    const v = habitsView(S([a, b, off], [L(a, D)]), D, 4);
    expect(v.rows.map((r) => [r.name, r.done])).toEqual([['Walk', false], ['Read', true]]);
    expect([v.done, v.total]).toEqual([1, 2]);
    expect(habitsView(S([a, b, off]), D, 1).rows).toHaveLength(1);
  });
});

describe('water: a Count habit, +1 glass per tap', () => {
  test('adds a glass, reaches the target as done, then refuses with the reason (no clamp)', () => {
    const w = water();
    let s = S([w]);
    for (let i = 1; i <= 3; i++) {
      const r = addGlassIn(s, D, C); if (typeof r === 'string') throw new Error(r);
      s = r.state;
      expect(waterView(s, D)).toEqual(expect.objectContaining({ kind: 'water', count: i, target: 3, done: i === 3 }));
    }
    expect(addGlassIn(s, D, C)).toBe('Water is at 3 of 3 glasses today. Raise the target to log more.');
  });
  test('a partial amount from the app goes up by one; the log keeps the target it was logged against', () => {
    const w = water();
    const s = S([{ ...w, target_value: 8 }], [L(w, D, { done: false, value: 1, target_snapshot: snapOf(w) })]);
    const r = addGlassIn(s, D, C) as { state: HabitsState };
    expect(r.state.logs[0]).toEqual(expect.objectContaining({ value: 2, done: false, target_snapshot: expect.objectContaining({ value: 3 }) }));
  });
  test('no water habit (or a yes / no "Water" habit) → the reason, nothing written', async () => {
    expect(addGlassIn(S([H({ short_name: 'Water' })]), D, C)).toBe('Add a Water habit first (Settings → Water).');
    expect(waterView(S([]), D).kind).toBe('none');
    mockKv.set(HABITS_KEY, JSON.stringify(S([])));
    expect(await addWater(NOW)).toMatch(/Add a Water habit/);
    expect(parseHabits(mockKv.get(HABITS_KEY)!).logs).toEqual([]);
  });
  test('the Water habit Settings creates passes the habit save checks (8 glasses, every day)', () => {
    expect(draftErrors(waterDraft(), [])).toEqual({});
    expect(waterDraft()).toEqual(expect.objectContaining({ kind: 'count', target_value: 8, unit: 'glasses', schedule: 'daily' }));
  });
});

describe('sync both ways with the running app', () => {
  let appListeners: ((s: string) => void)[] = [];
  beforeEach(() => {
    appListeners = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((_: string, f: (s: string) => void) => { appListeners.push(f); return { remove: () => { appListeners = appListeners.filter((x) => x !== f); } }; }) as never);
  });
  afterEach(() => jest.restoreAllMocks());
  async function mount() {
    let hb: Habits | null = null;
    function Probe() { hb = useHabits(); return null; }
    await act(async () => { create(<HabitsProvider now={() => NOW}><Probe /></HabitsProvider>); });
    await act(async () => {});
    return () => hb!;
  }
  test('app open: a widget tick goes through the provider (screen + store change together)', async () => {
    const w = water();
    mockKv.set(HABITS_KEY, JSON.stringify(S([w])));
    const hb = await mount();
    expect(liveHabits.current).not.toBeNull();
    await act(async () => { expect(await addWater(NOW)).toBeNull(); });
    await act(async () => {});
    expect(waterView(hb().state, dayOf(NOW)).count).toBe(1);
    expect(waterView(parseHabits(mockKv.get(HABITS_KEY)!), dayOf(NOW)).count).toBe(1);
    // the widget redraw reads the provider's latest state
    expect(waterView((await loadWidgetData(NOW)).habits, dayOf(NOW)).count).toBe(1);
  });
  test('app in the background: a widget write to the store shows when the app comes to the foreground', async () => {
    const a = H({ short_name: 'Read' });
    mockKv.set(HABITS_KEY, JSON.stringify(S([a])));
    const hb = await mount();
    liveHabits.current = null; // as if the widget ran without the provider (app process gone, store only)
    expect(await tickHabit(a.id, NOW)).toBeNull();
    expect(hb().state.logs).toEqual([]);
    await act(async () => { appListeners.forEach((f) => f('active')); });
    await act(async () => {});
    expect(hb().state.logs).toEqual([expect.objectContaining({ habit_id: a.id, done: true })]);
  });
  test('the foreground re-read does nothing when the store holds what the app saved', async () => {
    const a = H({ short_name: 'Read' });
    mockKv.set(HABITS_KEY, JSON.stringify(S([a])));
    const hb = await mount();
    await act(async () => { hb().toggle(a.id, dayOf(NOW), dayOf(NOW)); });
    await act(async () => {});
    const st = hb().state;
    await act(async () => { appListeners.forEach((f) => f('active')); });
    await act(async () => {});
    expect(hb().state).toBe(st);
  });
  test('WidgetSync redraws the widgets after an app change (debounced)', async () => {
    jest.useFakeTimers();
    const refresh = jest.fn(async () => {});
    let hb: Habits | null = null;
    function Probe() { hb = useHabits(); return null; }
    const a = H({ short_name: 'Read' });
    mockKv.set(HABITS_KEY, JSON.stringify(S([a])));
    await act(async () => { create(<StoreProvider><Probe /><WidgetSync refresh={refresh} available={() => true} /></StoreProvider>); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { jest.advanceTimersByTime(WIDGET_DEBOUNCE_MS + 10); });
    const n = refresh.mock.calls.length;
    await act(async () => { hb!.toggle(a.id, dayOf(), dayOf()); });
    await act(async () => { jest.advanceTimersByTime(WIDGET_DEBOUNCE_MS + 10); });
    expect(refresh.mock.calls.length).toBe(n + 1);
    jest.useRealTimers();
  });
});

describe('workout widget and stoke://start-workout', () => {
  const routine = { id: 'r1', name: 'Push A', exercises: [{ exercise_id: 'x', target: null, rest_s: 90 }] };
  const plan = (days: (string | null)[]): PlansState => ({ ...EMPTY_PLANS, plans: [{ id: 'p1', name: 'PPL', days, routines: [routine], created_at: '', updated_at: '' } as unknown as Plan], activeId: 'p1' });
  const wed = [null, null, 'r1', null, null, null, null];
  test('today’s routine starts; a workout in progress resumes; rest day only starts empty when asked; no plan → Choose a plan', () => {
    expect(startTarget(plan(wed), EMPTY_WORKOUTS, D, false)).toEqual(expect.objectContaining({ to: '/workout', start: 'routine', planId: 'p1' }));
    expect(startTarget(plan(wed), { ...EMPTY_WORKOUTS, active: { id: 's' } as never }, D, false)).toEqual({ to: '/workout', start: 'none' });
    expect(startTarget(plan([null, 'r1', null, null, null, null, null]), EMPTY_WORKOUTS, D, false)).toEqual({ to: '/train', start: 'none' });
    expect(startTarget(plan([null, 'r1', null, null, null, null, null]), EMPTY_WORKOUTS, D, true)).toEqual({ to: '/workout', start: 'empty' });
    expect(startTarget(EMPTY_PLANS, EMPTY_WORKOUTS, D, false)).toEqual({ to: '/choose-plan', start: 'none' });
  });
  test('what the widget says', () => {
    expect(workoutView(plan(wed), EMPTY_WORKOUTS, D)).toEqual({ kind: 'routine', title: 'Push A', sub: '1 exercise', button: 'Start workout' });
    expect(workoutView(EMPTY_PLANS, EMPTY_WORKOUTS, D).kind).toBe('none');
    expect(workoutView(plan(wed), { ...EMPTY_WORKOUTS, active: { id: 's', title: 'Push A' } as never }, D).button).toBe('Resume');
  });
});

describe('deep links', () => {
  const appDir = path.join(__dirname, '../src/app');
  const screenFor = (route: string) => {
    const p = route.split('?')[0].replace(/^\//, '');
    const cands = p === '' ? ['(tabs)/index.tsx'] : [`${p}.tsx`, `${p}/index.tsx`, `(tabs)/${p}.tsx`, `(tabs)/${p}/index.tsx`];
    return cands.find((c) => fs.existsSync(path.join(appDir, c))) ?? null;
  };
  test.each(Object.entries(ROUTES))('%s (%s) is a screen in src/app', (_, route) => { expect(screenFor(route)).not.toBeNull(); });
  test('stoke:// links', () => {
    expect(linkOf('stoke', ROUTES.logFood)).toBe('stoke://log-food');
    expect(linkOf('stoke', ROUTES.startWorkout)).toBe('stoke://start-workout');
    expect(linkOf('stoke', ROUTES.startEmpty)).toBe('stoke://start-workout?empty=1');
  });
});

describe('provider config (app.config.ts) and drawing', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cfg = require('../app.config').default;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { WIDGET_CONFIG } = require('../app.config');
  test('the scheme is stoke and the widget plugin lists the four widgets', () => {
    expect(cfg.scheme).toBe('stoke');
    const plugin = cfg.plugins.find((p: unknown) => Array.isArray(p) && p[0] === 'react-native-android-widget');
    expect(plugin[1]).toBe(WIDGET_CONFIG);
    expect(WIDGET_CONFIG.widgets.map((w: { name: string }) => w.name)).toEqual(WIDGET_NAMES);
  });
  test('2 cells wide, resizable between 2x1 and 2x2 only', () => {
    for (const w of WIDGET_CONFIG.widgets) {
      expect(w).toEqual(expect.objectContaining({ minWidth: '110dp', minHeight: '40dp', maxResizeWidth: '150dp', maxResizeHeight: '150dp', resizeMode: 'vertical', targetCellWidth: 2 }));
      expect([1, 2]).toContain(w.targetCellHeight);
    }
    for (const f of WIDGET_CONFIG.fonts) expect(fs.existsSync(path.join(__dirname, '..', f))).toBe(true);
    expect(isTall(40)).toBe(false); expect(isTall(120)).toBe(false); expect(isTall(160)).toBe(true);
  });
  const walk = (el: unknown, out: Record<string, unknown>[] = []) => {
    if (!el || typeof el !== 'object') return out;
    if (Array.isArray(el)) { el.forEach((x) => walk(x, out)); return out; }
    const e = el as { type: unknown; props: Record<string, unknown> };
    if (typeof e.type === 'function' && !(e.type as { __name__?: string }).__name__) return walk((e.type as (p: unknown) => unknown)(e.props), out);
    out.push(e.props); walk(e.props.children, out); return out;
  };
  const colors = (props: Record<string, unknown>[]) => props.flatMap((p) => Object.entries((p.style ?? {}) as Record<string, unknown>).filter(([k]) => /color/i.test(k)).map(([, v]) => String(v)));
  const data = { date: D, app: { entries: [row(D, 500, 20)], steps: {}, profile: PROFILE, themePref: 'system' as const },
    habits: S([H({ short_name: 'Read' }), water()]), plans: EMPTY_PLANS, workouts: EMPTY_WORKOUTS };
  test.each(WIDGET_NAMES.flatMap((n) => [[n, 40], [n, 160]] as [string, number][]))('%s at %idp high: light + dark, B2 colours only', (name, height) => {
    const r = widgetFor(name, data, { height }) as { light: unknown; dark: unknown };
    const lightSet = new Set(Object.values(palette.light).filter((v) => typeof v === 'string'));
    const darkSet = new Set(Object.values(palette.dark).filter((v) => typeof v === 'string'));
    const l = colors(walk(r.light)), d = colors(walk(r.dark));
    expect(l.length).toBeGreaterThan(0);
    for (const c of l) expect(lightSet).toContain(c);
    for (const c of d) expect(darkSet).toContain(c);
    expect(l).not.toEqual(d);
  });
  test('a theme picked in Settings is used for the widgets too', () => {
    const one = widgetFor(WIDGETS.today, { ...data, app: { ...data.app, themePref: 'dark' } }, { height: 160 }) as { props?: unknown };
    expect('light' in (one as object)).toBe(false);
  });
  test('tap targets: + Log food opens stoke://log-food; habit rows tick in the background; water adds a glass', () => {
    const uris = (name: string, h = 160) => walk((widgetFor(name, data, { height: h }) as { light: unknown }).light);
    expect(uris(WIDGETS.today).some((p) => p.clickAction === 'OPEN_URI' && (p.clickActionData as { uri: string }).uri === 'stoke://log-food')).toBe(true);
    expect(uris(WIDGETS.today, 40).some((p) => (p.clickActionData as { uri?: string } | undefined)?.uri === 'stoke://log-food')).toBe(true);
    const hb = uris(WIDGETS.habits).filter((p) => p.clickAction === ACTIONS.tickHabit);
    expect(hb.map((p) => (p.clickActionData as { id: string }).id)).toEqual(data.habits.habits.map((h) => h.id));
    expect(uris(WIDGETS.water).some((p) => p.clickAction === ACTIONS.addWater)).toBe(true);
    expect(uris(WIDGETS.water, 40).some((p) => p.clickAction === ACTIONS.addWater)).toBe(true);
    expect(uris(WIDGETS.workout).some((p) => (p.clickActionData as { uri?: string } | undefined)?.uri === 'stoke://choose-plan')).toBe(true);
  });
  test('a refused tap shows its reason on the widget', () => {
    const props = walk((widgetFor(WIDGETS.water, data, { height: 40 }, 'Water is at 3 of 3 glasses today.') as { light: unknown }).light);
    expect(props.some((p) => typeof p.text === 'string' && p.text.includes('3 of 3'))).toBe(true);
  });
});

void PLANS_KEY; void WORKOUTS_KEY;
