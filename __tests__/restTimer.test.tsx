// Item 11, rest timer C (spec §11; rest-timer/active-logger-timer-c, -expanded, -done): ticking starts the exercise's rest
// towards the next open set, −15s / +15s, Skip, rest done (vibrate once when on, Skip → +15s, next set outlined), the 8 s
// idle fade, the vibrate setting kept on the phone, and a finished workout never carries the timer.
import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { Vibration } from 'react-native';

jest.mock('../src/lib/config', () => ({ config: { mock: true, mockAi: false, mockAiDelay: 0 }, flags: {} }));
const mockKv = new Map<string, string>();
jest.mock('../src/lib/kv', () => ({ kv: { get: async (k: string) => mockKv.get(k) ?? null, set: async (k: string, v: string) => { mockKv.set(k, v); } } }));
let mockN = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `id-${++mockN}` }));
jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual('react-native');
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});
jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn(), push: jest.fn(), replace: jest.fn() }) }));

import { exercises } from '../src/lib/exercises';
import { StoreProvider } from '../src/lib/store';
import { useWorkouts, Workouts, WORKOUTS_KEY } from '../src/lib/workouts';
import { finished, mmss, nextOpenSet, Rest, restAfter, restLeft, restNextLabel, Session, shiftRest, WSet } from '../src/features/workout/model';
import { alertLine, IDLE_MS, RestTimer } from '../src/features/workout/RestTimer';

let k = 0; const id = () => `r${++k}`;
const open = (): WSet => ({ id: id(), kg_in: '', reps_in: '', done: false, kg: null, reps: null, done_at: null });
const doneSet = (kg: number, reps: number): WSet => ({ ...open(), done: true, kg, reps, kg_in: String(kg), reps_in: String(reps) });
const BENCH = 'wger-73', ROW = 'wger-1117';
const mk = (): Session => ({ id: 's', title: 'Pull A', plan_id: null, routine_id: null, local_date: '2026-10-21', started_at: '2026-10-21T12:40:00Z', ended_at: null,
  exercises: [{ id: 'a', exercise_id: BENCH, rest_s: 90, target: null, sets: [doneSet(60, 10), open(), open()] }, { id: 'b', exercise_id: ROW, rest_s: 0, target: null, sets: [open()] }] });

describe('rest model', () => {
  test('ticking starts the exercise rest toward the next open set; rest 0 starts none', () => {
    const s = mk(); const t0 = 1_000_000;
    const r = restAfter(s, 'a', s.exercises[0].sets[0].id, t0)!;
    expect(r).toEqual({ ends_at: t0 + 90_000, total_s: 90, ex_id: 'a', set_id: s.exercises[0].sets[1].id });
    expect(restAfter(s, 'b', s.exercises[1].sets[0].id, t0)).toBeNull();
  });
  test('next open set moves on to the next exercise, then wraps to an earlier one', () => {
    const s = mk();
    expect(nextOpenSet(s, 'a', s.exercises[0].sets[2].id)).toEqual({ ex: s.exercises[1], i: 0 });
    expect(nextOpenSet(s, 'b', s.exercises[1].sets[0].id)).toEqual({ ex: s.exercises[0], i: 1 });
  });
  test('−15s / +15s and the clock', () => {
    const r: Rest = { ends_at: 100_000, total_s: 90, ex_id: 'a', set_id: null };
    expect(restLeft(r, 28_000)).toBe(72);
    expect(mmss(72)).toBe('1:12');
    expect(restLeft(shiftRest(r, -15, 28_000), 28_000)).toBe(57);
    expect(restLeft(shiftRest(r, -90, 28_000), 28_000)).toBe(0); // done, never negative
    const plus = shiftRest(r, 15, 28_000);
    expect([restLeft(plus, 28_000), plus.total_s]).toEqual([87, 90]);
    // +15s after rest done counts from now
    expect(restLeft(shiftRest(r, 15, 200_000), 200_000)).toBe(15);
  });
  test('"Set 2 · 60 kg × 10" from typed values, else last time', () => {
    const s = mk(); const r = restAfter(s, 'a', s.exercises[0].sets[0].id, 0)!;
    expect(restNextLabel(s, r, () => [{ kg: 60, reps: 10 }], exercises)).toBe('Set 2 · 60 kg × 10');
    s.exercises[0].sets[1].kg_in = '62.5';
    expect(restNextLabel(s, r, () => [{ kg: 60, reps: 10 }], exercises)).toBe('Set 2 · 62.5 kg × 10');
    expect(restNextLabel(s, r, () => [], exercises)).toBe('Set 2');
  });
  test('a finished workout never carries the timer', () => {
    const s = { ...mk(), rest: { ends_at: 1, total_s: 90, ex_id: 'a', set_id: null } };
    expect('rest' in finished(s, new Date())).toBe(false);
  });
  test('alert line', () => expect([alertLine(true), alertLine(false)]).toEqual(['Vibrate on', 'Vibrate off']));
});

let w!: Workouts;
function Probe() { w = useWorkouts(); return null; }
const texts = (r: ReactTestRenderer) => r.root.findAll((x) => typeof x.type === 'string').flatMap((x) => [x.props.children].flat()).filter((c) => typeof c === 'string').join('|');
const byLabel = (r: ReactTestRenderer, l: string | RegExp) => r.root.findAll((x) => typeof x.props.onPress === 'function' && (typeof l === 'string' ? x.props.accessibilityLabel === l : l.test(String(x.props.accessibilityLabel ?? ''))));
const press = (r: ReactTestRenderer, l: string | RegExp) => { const m = byLabel(r, l); if (!m.length) throw new Error(`no ${l}`); return act(async () => { m[0].props.onPress(); }); };
async function mountAt(now: number) {
  let r!: ReactTestRenderer;
  await act(async () => { r = create(<StoreProvider><Probe /><RestTimer now={now} repo={exercises} /></StoreProvider>); });
  await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
  return r;
}
const at = (r: ReactTestRenderer, now: number) => act(async () => { r.update(<StoreProvider><Probe /><RestTimer now={now} repo={exercises} /></StoreProvider>); });
beforeEach(() => { mockKv.clear(); jest.restoreAllMocks(); });

describe('rest timer on screen', () => {
  async function ticked() {
    const r = await mountAt(Date.now());
    await act(async () => { w.startEmpty(); w.addExercise(BENCH); });
    const x = w.active!.exercises[0];
    await act(async () => { w.setInput(x.id, x.sets[0].id, 'kg_in', '60'); w.setInput(x.id, x.sets[0].id, 'reps_in', '10'); });
    await act(async () => { expect(w.tick(x.id, x.sets[0].id)).toBeNull(); });
    return { r, rest: w.active!.rest! };
  }
  test('tick → pill "1:12 · Set 2 …" with Skip; Skip ends it; the timer is kept on the phone', async () => {
    const { r, rest } = await ticked();
    expect(rest.total_s).toBe(90);
    expect(JSON.parse(mockKv.get(WORKOUTS_KEY)!).active.rest.ends_at).toBe(rest.ends_at);
    await at(r, rest.ends_at - 72_000);
    expect(texts(r)).toContain('1:12');
    expect(texts(r)).toContain(' · Set 2');
    expect(texts(r)).toContain('Vibrate on');
    await press(r, 'Skip rest');
    expect(w.active!.rest).toBeNull();
    await act(async () => { r.unmount(); });
  });
  test('expanded: "of 1:30", −15s / +15s, vibrate switch', async () => {
    const { r, rest } = await ticked();
    await at(r, rest.ends_at - 72_000);
    await press(r, /Open rest timer$/);
    expect(texts(r)).toContain('  of 1:30');
    await press(r, '−15s');
    expect(w.active!.rest!.ends_at).toBe(rest.ends_at - 15_000);
    await press(r, 'Vibrate when rest ends');
    expect(w.state.prefs.vibrate).toBe(false);
    expect(JSON.parse(mockKv.get(WORKOUTS_KEY)!).prefs.vibrate).toBe(false);
    await act(async () => { r.unmount(); });
  });
  test('rest done: vibrates once, "Rest done", Skip becomes +15s; fades after 8 s with no touch', async () => {
    const vib = jest.spyOn(Vibration, 'vibrate').mockImplementation(() => {});
    const { r, rest } = await ticked();
    const t = rest.ends_at + 500;
    await at(r, t);
    expect(texts(r)).toContain('Rest done');
    expect(byLabel(r, 'Add 15 seconds')).toHaveLength(1);
    await at(r, t + 1000);
    expect(vib).toHaveBeenCalledTimes(1);
    await at(r, t + IDLE_MS + 10);
    expect(w.active!.rest).toBeNull();
    await act(async () => { r.unmount(); });
  });
});
