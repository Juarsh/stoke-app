// Item 12: workout summary (after Finish), Workout history, session detail, Train "History" + split Done / Last, Today's
// card "Last time", Home chip "N workouts in 7 days". PRs and trends are cut (CEO), so none of that shows.
import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';

jest.mock('../src/lib/config', () => ({ config: { mock: true, mockAi: false, mockAiDelay: 0 }, flags: {} }));
const mockKv = new Map<string, string>();
jest.mock('../src/lib/kv', () => ({ kv: { get: async (k: string) => mockKv.get(k) ?? null, set: async (k: string, v: string) => { mockKv.set(k, v); } } }));
let mockN = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `id-${++mockN}` }));
jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual('react-native');
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});
const mockPush = jest.fn(); const mockBack = jest.fn(); const mockReplace = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ back: mockBack, push: mockPush, replace: mockReplace, canGoBack: () => true }) }));

import { addDays, dayOf } from '../src/lib/domain';
import { exercises } from '../src/lib/exercises';
import { StoreProvider } from '../src/lib/store';
import { usePlans, Plans } from '../src/lib/plans';
import { useWorkouts, Workouts, WORKOUTS_KEY } from '../src/lib/workouts';
import { weekdayOf } from '../src/features/plans/model';
import { TrainScreen } from '../src/features/plans/TrainScreen';
import { TodayCard } from '../src/features/plans/TodayCard';
import { bestLine, dayLabel, historyGroups, lastTimeLine, proteinNudge, setsLine, sinceLine, timeRange, titleChips, topSet, weekCount, weekRange } from '../src/features/workout/history';
import { Session, WSet } from '../src/features/workout/model';
import { CALORIE_NOTE, SummaryScreen } from '../src/features/workout/SummaryScreen';
import { HistoryScreen } from '../src/features/workout/HistoryScreen';
import { SessionScreen } from '../src/features/workout/SessionScreen';

const BENCH = 'wger-73', ROW = 'wger-1117', PULLUP = 'wger-475';
let k = 0;
const set = (kg: number | null, reps: number): WSet => ({ id: `y${++k}`, kg_in: '', reps_in: '', done: true, kg, reps, done_at: null });
const ex = (exercise_id: string, sets: WSet[]) => ({ id: `x${++k}`, exercise_id, rest_s: 90, target: null, sets });
const sess = (p: Partial<Session> & { local_date: string }): Session => ({ id: `s${++k}`, title: 'Push A', plan_id: null, routine_id: null,
  started_at: `${p.local_date}T12:50:00.000Z`, ended_at: `${p.local_date}T13:52:00.000Z`, exercises: [], ...p });

describe('history model', () => {
  const bench = ex(BENCH, [set(80, 6), set(80, 6), set(77.5, 7), set(75, 8)]);
  test('labels', () => {
    expect(dayLabel('2026-10-20')).toBe('Tue 20 Oct');
    expect(timeRange(sess({ local_date: '2026-10-20', started_at: '2026-10-20T12:40:00.000Z', ended_at: '2026-10-20T13:38:00.000Z' }))).toBe('6:10–7:08 PM');
    expect(timeRange(sess({ local_date: '2026-10-20', started_at: '2026-10-20T06:20:00.000Z', ended_at: '2026-10-20T06:40:00.000Z' }))).toBe('11:50 AM–12:10 PM');
    expect(weekRange('2026-10-12')).toBe('12–18 Oct');
    expect(weekRange('2026-09-28')).toBe('28 Sep–4 Oct');
  });
  test('best set, compact sets line, bodyweight and timed', () => {
    expect(bestLine(bench, 'weight')).toBe('4 sets · best 80 kg × 6');
    expect(setsLine(bench, 'weight')).toBe('80×6 · 80×6 · 77.5×7 · 75×8');
    const pu = ex(PULLUP, [set(null, 12), set(10, 8)]);
    expect(bestLine(pu, 'bodyweight')).toBe('2 sets · best BW + 10 kg × 8');
    expect(setsLine(pu, 'bodyweight')).toBe('BW×12 · +10×8');
    expect(bestLine(ex('t', [set(null, 45), set(null, 60)]), 'time')).toBe('2 sets · best 60 s');
  });
  test('top set is the heaviest weighted set (bodyweight / timed never count)', () => {
    const s = sess({ local_date: '2026-10-19', exercises: [bench, ex(ROW, [set(70, 8)]), ex(PULLUP, [set(40, 5)])] });
    expect(topSet(s, exercises)).toMatch(/ 80 kg × 6$/);
    expect(topSet(sess({ local_date: '2026-10-19', exercises: [ex(PULLUP, [set(null, 10)])] }), exercises)).toBeNull();
  });
  test('groups: "This week", then "12–18 Oct · 2 workouts"; since line; title chips; 7-day count', () => {
    const ss = [sess({ local_date: '2026-10-19' }), sess({ local_date: '2026-10-13', title: 'Pull A' }), sess({ local_date: '2026-10-17', title: 'Pull B' }), sess({ local_date: '2026-08-24' })];
    const g = historyGroups(ss, '2026-10-21');
    expect(g.map((x) => x.title)).toEqual(['This week', '12–18 Oct · 2 workouts', '24–30 Aug · 1 workout']);
    expect(g[1].sessions.map((s) => s.title)).toEqual(['Pull B', 'Pull A']);
    expect(sinceLine(ss)).toBe('4 since 24 Aug');
    expect(titleChips(ss)).toEqual(['Push A', 'Pull A', 'Pull B']);
    expect(titleChips([ss[0]])).toEqual([]);
    expect(weekCount(ss, '2026-10-21')).toBe(2); // 15–21 Oct: the 19th and the 17th
  });
  test('protein nudge and last time', () => {
    expect(proteinNudge(44, 82)).toBe('Protein: 44 of 82 g today. A meal with about 25 g helps recovery.');
    expect(proteinNudge(70, 82)).toBe('Protein: 70 of 82 g today. A meal with about 10 g helps recovery.');
    expect(proteinNudge(90, 82)).toBe('Protein: 90 of 82 g today. You’ve hit your protein goal.');
    expect(lastTimeLine(sess({ local_date: '2026-10-13' }), 6900)).toBe('Last time: Tue 13 Oct · 62 min · 6,900 kg');
  });
});

let w!: Workouts; let pl!: Plans;
function Probe() { w = useWorkouts(); pl = usePlans(); return null; }
const texts = (r: ReactTestRenderer) => r.root.findAll((x) => typeof x.type === 'string').flatMap((x) => [x.props.children].flat()).filter((c) => typeof c === 'string').join('|');
const press = (r: ReactTestRenderer, l: string) => { const m = r.root.findAll((x) => typeof x.props.onPress === 'function' && x.props.accessibilityLabel === l); if (!m.length) throw new Error(`no ${l}`); return act(async () => { m[0].props.onPress(); }); };
async function mount(el: React.ReactElement) {
  let r!: ReactTestRenderer;
  await act(async () => { r = create(<StoreProvider><Probe />{el}</StoreProvider>); });
  await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
  return r;
}
const seed = (sessions: Session[]) => mockKv.set(WORKOUTS_KEY, JSON.stringify({ v: 1, active: null, sessions, prefs: { vibrate: true } }));
beforeEach(() => { mockKv.clear(); mockPush.mockClear(); mockBack.mockClear(); mockReplace.mockClear(); });

describe('screens', () => {
  const today = dayOf();
  test('summary: stats, best sets, protein nudge, calorie note, Done; no PR badges', async () => {
    const s = sess({ local_date: today, title: 'Pull A', exercises: [ex(ROW, [set(50, 10), set(50, 10)]), ex(PULLUP, [set(null, 10)])] });
    seed([s]);
    const r = await mount(<SummaryScreen id={s.id} />);
    const tx = texts(r);
    expect(tx).toContain('Workout done');
    expect(tx).toContain('62 min');
    expect(tx).toContain('1,000 kg');
    expect(tx).toContain('2 sets · best 50 kg × 10');
    expect(tx).toContain('1 set · best BW × 10');
    expect(tx).toContain('Log food ›');
    expect(tx).toContain(CALORIE_NOTE);
    expect(tx).not.toMatch(/personal record|\bPR\b/);
    await press(r, 'Ask Coach'); expect(mockPush).toHaveBeenCalledWith('/coach');
    await press(r, 'Done'); expect(mockBack).toHaveBeenCalled();
    await act(async () => { r.unmount(); });
  });
  test('history: header count, groups, cards open the session; empty state', async () => {
    let r = await mount(<HistoryScreen />);
    expect(texts(r)).toContain('No workouts yet');
    await act(async () => { r.unmount(); });
    const a = sess({ local_date: today, title: 'Push A', exercises: [ex(BENCH, [set(80, 6)])] });
    const b = sess({ local_date: addDays(today, -14), title: 'Pull A', exercises: [ex(ROW, [set(70, 8)])] });
    seed([b, a]);
    r = await mount(<HistoryScreen />);
    const tx = texts(r);
    expect(tx).toContain(`2 since ${dayLabel(b.local_date).slice(4)}`);
    expect(tx).toContain('This week');
    expect(tx).toContain('62 min · 1 exercise · 1 set · 6 reps');
    expect(tx).toMatch(/Top set: .* 80 kg × 6/);
    await press(r, 'Pull A'); // chip
    expect(texts(r)).not.toContain('This week');
    const card = r.root.findAll((x) => typeof x.props.onPress === 'function' && String(x.props.accessibilityLabel ?? '').startsWith('Pull A,'))[0];
    await act(async () => { card.props.onPress(); });
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/train/session/[id]', params: { id: b.id } });
    await act(async () => { r.unmount(); });
  });
  test('session detail: sets line, volume; Delete asks first and removes it', async () => {
    const s = sess({ local_date: today, exercises: [ex(BENCH, [set(80, 6), set(77.5, 7)])] });
    seed([s]);
    const r = await mount(<SessionScreen id={s.id} />);
    expect(texts(r)).toContain('80×6 · 77.5×7');
    expect(texts(r)).toContain('1,023 kg'); // 80×6 + 77.5×7 = 1,022.5
    await press(r, 'Delete workout');
    expect(texts(r)).toContain('Delete workout?');
    const drop = r.root.findAll((x) => typeof x.props.onPress === 'function' && x.props.accessibilityLabel === 'Delete workout');
    await act(async () => { drop[drop.length - 1].props.onPress(); });
    expect(w.state.sessions).toHaveLength(0);
    expect(mockBack).toHaveBeenCalled();
    await act(async () => { r.unmount(); });
  });
  test('Train: History link; split shows Done today and "Last <date>" for an earlier routine; Today\'s card "Last time"', async () => {
    const r = await mount(<TrainScreen />);
    let plan!: ReturnType<Plans['applyTemplate']>;
    await act(async () => { plan = pl.applyTemplate('ppl'); });
    const [r1, r2] = plan.routines;
    const wd = weekdayOf(today), other = (wd + 3) % 7;
    await act(async () => { pl.setDay(plan.id, wd, r1.id); });
    await act(async () => { pl.setDay(plan.id, other, r2.id); });
    const old = sess({ local_date: addDays(today, -10), title: r2.name, routine_id: r2.id, exercises: [ex(BENCH, [set(60, 10)])] });
    const prevR1 = sess({ local_date: addDays(today, -7), title: r1.name, routine_id: r1.id, exercises: [ex(BENCH, [set(60, 10)])] });
    await act(async () => { seed([old, prevR1]); });
    await act(async () => { r.unmount(); });
    const r3 = await mount(<><TrainScreen /><TodayCard date={today} /></>);
    let tx = texts(r3);
    expect(tx).toContain(`Last ${dayLabel(old.local_date).slice(4)}`);
    expect(tx).toContain(lastTimeLine(prevR1, 600));
    await press(r3, 'Workout history');
    expect(mockPush).toHaveBeenCalledWith('/train/history');
    // save today's r1 → its row says Done
    await act(async () => { w.start(r1, plan.id); });
    const x = w.active!.exercises[0];
    await act(async () => { w.setInput(x.id, x.sets[0].id, 'kg_in', '40'); w.setInput(x.id, x.sets[0].id, 'reps_in', '8'); });
    await act(async () => { w.tick(x.id, x.sets[0].id); });
    await act(async () => { expect(typeof w.finish()).toBe('object'); });
    tx = texts(r3);
    expect(tx).toContain('Done');
    await act(async () => { r3.unmount(); });
  });
});
