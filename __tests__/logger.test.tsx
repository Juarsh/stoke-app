// Item 10, active workout logger (full-b2 active-logger / -finish / -discard, states #7 resume, #10 bodyweight, #11 empty):
// starting from a routine or empty, previous numbers and the grey prefill, ticking (checked, never clamped), the header
// numbers (kg only, no bodyweight volume, CEO Q1), Finish (only ticked sets saved), storage via LocalStore, resume.
import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { TextInput } from 'react-native';

jest.mock('../src/lib/config', () => ({ config: { mock: true, mockAi: false, mockAiDelay: 0 }, flags: {} }));
const mockKv = new Map<string, string>();
jest.mock('../src/lib/kv', () => ({ kv: { get: async (k: string) => mockKv.get(k) ?? null, set: async (k: string, v: string) => { mockKv.set(k, v); } } }));
let mockN = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `id-${++mockN}` }));
jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual('react-native');
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});
const mockPush = jest.fn(); const mockBack = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ back: mockBack, push: mockPush, replace: mockPush }) }));

import { exercises } from '../src/lib/exercises';
import { Plans, usePlans } from '../src/lib/plans';
import { Store, StoreProvider, useStore } from '../src/lib/store';
import { useWorkouts, Workouts, WORKOUTS_KEY } from '../src/lib/workouts';
import { fromTemplate } from '../src/features/plans/model';
import {
  checkSet, doneLine, kindOf, elapsed, EMPTY_WORKOUTS, finishAsk, finished, ghost, newExercise, parseWorkouts, prevLabel, previousSets, Session, startEmpty,
  startFromRoutine, stats, WSet,
} from '../src/features/workout/model';
import { LoggerScreen, savedLine } from '../src/features/workout/LoggerScreen';
import { TodayCard } from '../src/features/plans/TodayCard';

let k = 0; const id = () => `m${++k}`;
const set = (kg: number | null, reps: number | null, done = true): WSet => ({ id: id(), kg_in: '', reps_in: '', done, kg, reps, done_at: done ? '2026-10-19T13:00:00Z' : null });
const sess = (o: Partial<Session> & { exercises: Session['exercises'] }): Session =>
  ({ id: id(), title: 'Push A', plan_id: null, routine_id: null, local_date: '2026-10-19', started_at: '2026-10-19T12:50:00.000Z', ended_at: '2026-10-19T13:50:00.000Z', ...o });
const ex = (exercise_id: string, sets: WSet[]) => ({ id: id(), exercise_id, rest_s: 90, target: null, sets });
const BENCH = 'wger-73', PULLUP = 'wger-475', PLANK = 'wger-458';

describe('starting', () => {
  test('from a routine: its exercises, the target’s sets (3 without), its rest; the log day is the 4 AM day', () => {
    const p = fromTemplate('ppl', id, '2026-10-21T08:00:00Z');
    const s = startFromRoutine(p.routines[0], p.id, id, new Date('2026-10-22T01:30:00+05:30'));
    expect(s.title).toBe('Push A');
    expect(s.local_date).toBe('2026-10-21');
    expect(s.exercises.map((x) => x.sets.length)).toEqual([4, 3, 3, 3, 3, 3]);
    expect(s.exercises[0].rest_s).toBe(150);
    expect(s.exercises.every((x) => x.sets.every((y) => !y.done && y.reps === null))).toBe(true);
  });
  test('empty workout has no exercises', () => {
    const s = startEmpty(id, new Date('2026-10-21T12:40:00+05:30'));
    expect([s.title, s.exercises.length, s.routine_id]).toEqual(['Empty workout', 0, null]);
  });
});

describe('previous numbers and the grey prefill', () => {
  const old = sess({ started_at: '2026-10-12T12:00:00Z', exercises: [ex(BENCH, [set(50, 10)])] });
  const last = sess({ exercises: [ex(BENCH, [set(60, 10), set(62.5, 8), set(70, 1, false)])] });
  const open = sess({ started_at: '2026-10-20T12:00:00Z', ended_at: null, exercises: [ex(BENCH, [set(99, 9)])] });
  test('the latest finished workout with done sets; open workouts and undone sets are ignored', () => {
    expect(previousSets([old, last, open], BENCH)).toEqual([{ kg: 60, reps: 10 }, { kg: 62.5, reps: 8 }]);
    expect(previousSets([old, last], PULLUP)).toEqual([]);
  });
  test('labels', () => {
    expect(prevLabel({ kg: 55, reps: 10 }, 'weight')).toBe('55 kg × 10');
    expect(prevLabel({ kg: 62.5, reps: 8 }, 'weight')).toBe('62.5 kg × 8');
    expect(prevLabel({ kg: null, reps: 8 }, 'bodyweight')).toBe('BW × 8');
    expect(prevLabel({ kg: 10, reps: 6 }, 'bodyweight')).toBe('BW +10 × 6');
    expect(prevLabel({ kg: null, reps: 45 }, 'time')).toBe('45 s');
    expect(prevLabel(undefined, 'weight')).toBe('—');
  });
  test('grey: same position, else the last set of last time, else the target reps', () => {
    const prev = previousSets([last], BENCH);
    expect(ghost(prev, 1, null)).toEqual({ kg: '62.5', reps: '8' });
    expect(ghost(prev, 3, null)).toEqual({ kg: '62.5', reps: '8' });
    expect(ghost([], 0, { sets: 3, repsLow: 6, repsHigh: 8 })).toEqual({ kg: '', reps: '8' });
    expect(ghost([], 0, null)).toEqual({ kg: '', reps: '' });
  });
});

describe('ticking a set: checked, never clamped', () => {
  const g = { kg: '60', reps: '10' }, none = { kg: '', reps: '' };
  test('empty boxes log the grey values; typed values win', () => {
    expect(checkSet('', '', g, 'weight')).toEqual({ ok: true, kg: 60, reps: 10 });
    expect(checkSet('62,5', '8', g, 'weight')).toEqual({ ok: true, kg: 62.5, reps: 8 });
  });
  test.each<[string, string, { kg: string; reps: string }, 'weight' | 'bodyweight' | 'time', string]>([
    ['', '', none, 'weight', 'Enter the reps first.'],
    ['', '10', none, 'weight', 'Enter the kg first.'],
    ['60', '0', g, 'weight', 'Reps must be a whole number from 1 to 200.'],
    ['60', '201', g, 'weight', 'Reps must be a whole number from 1 to 200.'],
    ['60', '8.5', g, 'weight', 'Reps must be a whole number from 1 to 200.'],
    ['1001', '5', g, 'weight', 'kg must be a number from 0 to 1,000.'],
    ['-5', '5', g, 'weight', 'kg must be a number from 0 to 1,000.'],
    ['abc', '5', g, 'weight', 'kg must be a number from 0 to 1,000.'],
    ['62.555', '5', g, 'weight', 'kg can have at most 2 decimals (like 62.5).'],
    ['', '', none, 'time', 'Enter the seconds first.'],
  ])('kg "%s" reps "%s" → refused', (kg, reps, gh, kind, why) => expect(checkSet(kg, reps, gh, kind)).toEqual({ ok: false, reason: why }));
  test('bodyweight: kg is optional added weight; time: seconds', () => {
    expect(checkSet('', '8', none, 'bodyweight')).toEqual({ ok: true, kg: null, reps: 8 });
    expect(checkSet('10', '6', none, 'bodyweight')).toEqual({ ok: true, kg: 10, reps: 6 });
    expect(checkSet('', '45', none, 'time')).toEqual({ ok: true, kg: null, reps: 45 });
  });
});

describe('header numbers', () => {
  test('volume = kg × reps over done sets; bodyweight counts added kg only; timed sets count none', () => {
    const s = sess({ ended_at: null, exercises: [ex(BENCH, [set(60, 10), set(60, 10, false)]), ex(PULLUP, [set(null, 8), set(10, 6)]), ex(PLANK, [set(null, 45)]), ex('wger-184', [set(null, null, false)])] });
    expect(stats(s, exercises)).toEqual({ volume: 660, done: 4, total: 6, reps: 24, started: 3, exercises: 4 });
  });
  test('time and collapsed line', () => {
    expect(elapsed('2026-10-21T10:00:00Z', Date.parse('2026-10-21T10:32:14Z'))).toBe('32:14');
    expect(elapsed('2026-10-21T10:00:00Z', Date.parse('2026-10-21T11:02:03Z'))).toBe('1:02:03');
    expect(doneLine(ex('wger-184', [set(100, 5), set(110, 5), set(120, 5)]), 'weight')).toBe('3 of 3 sets · 100, 110, 120 kg × 5');
    expect(doneLine(ex(PULLUP, [set(null, 8), set(10, 6)]), 'bodyweight')).toBe('2 of 2 sets · BW × 8, BW +10 × 6');
  });
});

describe('finish', () => {
  test('nothing ticked → discard; some open → confirm with counts; all done → save', () => {
    expect(finishAsk(sess({ exercises: [ex(BENCH, [set(null, null, false)])] }))).toEqual({ kind: 'discard' });
    expect(finishAsk(sess({ exercises: [ex(BENCH, [set(60, 10), set(null, null, false)]), ex(PULLUP, [set(null, null, false)])] }))).toEqual({ kind: 'confirm', undone: 2, total: 3 });
    expect(finishAsk(sess({ exercises: [ex(BENCH, [set(60, 10)])] }))).toEqual({ kind: 'save' });
  });
  test('only ticked sets are saved; exercises with none are dropped', () => {
    const f = finished(sess({ ended_at: null, exercises: [ex(BENCH, [set(60, 10), set(null, null, false)]), ex(PULLUP, [set(null, null, false)])] }), new Date('2026-10-21T13:00:00Z'));
    expect(f.ended_at).toBe('2026-10-21T13:00:00.000Z');
    expect(f.exercises.map((x) => [x.exercise_id, x.sets.length])).toEqual([[BENCH, 1]]);
  });
  test('parse: junk → empty; a saved state comes back as is', () => {
    expect(parseWorkouts('nope')).toEqual(EMPTY_WORKOUTS);
    expect(parseWorkouts(JSON.stringify({ entries: [] }))).toEqual(EMPTY_WORKOUTS);
    const st = { v: 1, active: null, sessions: [sess({ exercises: [ex(BENCH, [set(60, 10)])] })] };
    expect(parseWorkouts(JSON.stringify(st))).toEqual(st);
  });
});

// ---------- store + screens ----------
let w!: Workouts; let plans!: Plans; let st!: Store;
function Probe() { w = useWorkouts(); plans = usePlans(); st = useStore(); return null; }
async function mount(ui: React.ReactElement) {
  let r!: ReactTestRenderer;
  await act(async () => { r = create(<StoreProvider><Probe />{ui}</StoreProvider>); });
  await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
  return r;
}
const byLabel = (r: ReactTestRenderer, l: string | RegExp) => r.root.findAll((x) => typeof x.props.onPress === 'function' && (typeof l === 'string' ? x.props.accessibilityLabel === l : l.test(String(x.props.accessibilityLabel ?? ''))));
const press = (r: ReactTestRenderer, l: string | RegExp, i = 0) => { const m = byLabel(r, l); if (!m.length) throw new Error(`no ${l}`); return act(async () => { m[i].props.onPress(); }); };
const texts = (r: ReactTestRenderer) => r.root.findAll((x) => typeof x.type === 'string').flatMap((x) => [x.props.children].flat()).filter((c) => typeof c === 'string').join('|');
const input = (r: ReactTestRenderer, label: string, v: string) => act(async () => { r.root.findAll((x) => x.type === TextInput && x.props.accessibilityLabel === label)[0].props.onChangeText(v); });
const savedW = () => JSON.parse(mockKv.get(WORKOUTS_KEY) ?? 'null');
// a finished Push A last Monday: bench 60 × 10, 62.5 × 8
const seed = () => mockKv.set(WORKOUTS_KEY, JSON.stringify({ v: 1, active: null, sessions: [sess({ exercises: [ex(BENCH, [set(60, 10), set(62.5, 8)])] })] }));
beforeEach(() => { mockKv.clear(); mockPush.mockClear(); mockBack.mockClear(); });

describe('starting from Home / Train', () => {
  test('Start workout starts today’s routine, saves it on the phone and opens the logger; a second start keeps it', async () => {
    const r = await mount(<TodayCard date="2026-10-20" />);
    await act(async () => { plans.applyTemplate('ppl'); });
    await press(r, 'Start workout');
    expect(mockPush).toHaveBeenLastCalledWith('/workout');
    expect(savedW().active.title).toBe('Pull A');
    const first = w.active!.id;
    await act(async () => { w.start(plans.state.plans[0].routines[0], plans.state.plans[0].id); });
    expect(w.active!.id).toBe(first);
    // the card is now the resume banner (states #7)
    expect(texts(r)).toMatch(/Pull A in progress · \d+ min/);
    expect(texts(r)).toContain('0 of 18 sets are saved.');
    await act(async () => { r.unmount(); });
  });
  test('after a restart the workout in progress is still there (resume); Discard asks first', async () => {
    let r = await mount(<></>);
    await act(async () => { w.startEmpty(); });
    await act(async () => { r.unmount(); });
    r = await mount(<TodayCard date="2026-10-20" />);
    expect(w.active?.title).toBe('Empty workout');
    await press(r, 'Discard workout');
    expect(texts(r)).toContain('No sets are ticked, so there is nothing to save.');
    await press(r, 'Discard workout', 1);
    expect(w.active).toBeNull();
    await act(async () => { r.unmount(); });
  });
});

describe('logger screen', () => {
  async function bench() {
    seed();
    const r = await mount(<LoggerScreen />);
    await act(async () => { w.startEmpty(); w.addExercise(BENCH); });
    return r;
  }
  test('previous column and grey hint from last time; one tap on ✓ logs the grey values', async () => {
    const r = await bench();
    const s = texts(r);
    expect(s).toContain('60 kg × 10');
    expect(s).toContain('62.5 kg × 8');
    expect(s).toContain('Grey is last time. Tap ✓ to log 60 × 10.');
    await press(r, 'Set 1 done');
    const y = w.active!.exercises[0].sets[0];
    expect([y.done, y.kg, y.reps]).toEqual([true, 60, 10]);
    expect(texts(r)).toContain('600 kg');
    expect(texts(r)).toContain('1 of 3');
    expect(savedW().active.exercises[0].sets[0].kg).toBe(60);
    await act(async () => { r.unmount(); });
  });
  test('a bad value is refused with the reason under the row; the set stays open with the typed text', async () => {
    const r = await bench();
    await input(r, 'Set 2 kg', '1200');
    await press(r, 'Set 2 done');
    expect(texts(r)).toContain('kg must be a number from 0 to 1,000.');
    const y = w.active!.exercises[0].sets[1];
    expect([y.done, y.kg, y.kg_in]).toEqual([false, null, '1200']);
    await act(async () => { r.unmount(); });
  });
  test('tapping a filled ✓ opens the set again with its numbers', async () => {
    const r = await bench();
    await press(r, 'Set 1 done');
    await press(r, 'Set 1 done');
    const y = w.active!.exercises[0].sets[0];
    expect([y.done, y.kg, y.kg_in, y.reps_in]).toEqual([false, null, '60', '10']);
    await act(async () => { r.unmount(); });
  });
  test('Finish with open sets: "N of M sets not done"; Finish anyway saves only ticked sets and returns with a notice', async () => {
    const r = await bench();
    await press(r, 'Set 1 done');
    await press(r, 'Finish workout');
    expect(texts(r)).toContain('2 of 3 sets not done. Only ticked sets are saved.');
    await press(r, 'Finish anyway');
    expect(w.active).toBeNull();
    const last = w.state.sessions[w.state.sessions.length - 1];
    expect(last.exercises[0].sets.map((y) => [y.kg, y.reps])).toEqual([[60, 10]]);
    expect(savedW().sessions).toHaveLength(2);
    expect(st.notice).toBe(savedLine(last, 600));
    expect(mockBack).toHaveBeenCalled();
    await act(async () => { r.unmount(); });
  });
  test('Finish with nothing ticked asks "Discard workout?"', async () => {
    const r = await bench();
    await press(r, 'Finish workout');
    expect(texts(r)).toContain('No sets are ticked, so there is nothing to save.');
    await press(r, 'Discard workout');
    expect(w.active).toBeNull();
    expect(savedW().sessions).toHaveLength(1);
    await act(async () => { r.unmount(); });
  });
  test('empty workout: "No exercises yet" with Add exercise; Add set / Remove set from ⋯', async () => {
    const r = await mount(<LoggerScreen />);
    await act(async () => { w.startEmpty(); });
    expect(texts(r)).toContain('No exercises yet');
    await act(async () => { w.addExercise(PULLUP); });
    expect(texts(r)).toContain('BW is your bodyweight. Volume counts added kg only.');
    await press(r, /^Add set to /);
    expect(w.active!.exercises[0].sets).toHaveLength(4);
    await press(r, /^More for /);
    await press(r, 'Remove set 4');
    expect(w.active!.exercises[0].sets).toHaveLength(3);
    await act(async () => { r.unmount(); });
  });
  test('new exercise has 3 open sets', () => expect(newExercise(BENCH, id).sets).toHaveLength(3));
  test('Pull-ups (pull-up bar) log as bodyweight even though the source row says weight_reps', () => {
    expect(exercises.byId(PULLUP)!.type).toBe('weight_reps');
    expect(kindOf(exercises.byId(PULLUP))).toBe('bodyweight');
    expect(kindOf(exercises.byId(BENCH))).toBe('weight');
    expect(kindOf(exercises.byId(PLANK))).toBe('time');
  });
});
