// Item 9, Plans and weekly split + Today's workout card (spec §2 vocabulary, CEO Q1; full-b2 train / plan-builder /
// plan-builder-delete / home / home-empty / states #8): templates, today from the 4 AM log day, labels, the save checks
// (refuse with a reason, never clamp), storage through the LocalStore seam, and the Home / Train / routine screens.
import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { TextInput } from 'react-native';

jest.mock('../src/lib/config', () => ({ config: { mock: true, mockAi: false, mockAiDelay: 0 }, flags: {} }));
const mockKv = new Map<string, string>();
const mockWrites: string[] = [];
jest.mock('../src/lib/kv', () => ({ kv: { get: async (k: string) => mockKv.get(k) ?? null, set: async (k: string, v: string) => { mockWrites.push(k); mockKv.set(k, v); } } }));
let mockN = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `id-${++mockN}` }));
jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual('react-native');
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});
const mockPush = jest.fn(); const mockBack = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ back: mockBack, push: mockPush, replace: mockPush }) }));

import { dayOf } from '../src/lib/domain';
import { exercises } from '../src/lib/exercises';
import { PLANS_KEY, Plans, usePlans } from '../src/lib/plans';
import { StoreProvider } from '../src/lib/store';
import {
  blankPlan, daysLabel, EMPTY_PLANS, estMinutes, fromTemplate, move, namesLine, nextLine, Plan, planError, parsePlans, removeRoutine, restLabel, Routine,
  routineError, setDay, splitRows, step, stepReps, targetLabel, TEMPLATES, todayWorkout, uniqueName, weekdayOf, LIMITS,
} from '../src/features/plans/model';
import { TodayCard, LOGGER_SOON } from '../src/features/plans/TodayCard';
import { TrainScreen } from '../src/features/plans/TrainScreen';
import { RoutineScreen } from '../src/features/plans/RoutineScreen';

const NOW = '2026-10-21T08:00:00.000Z';
let k = 0; const id = () => `t${++k}`;
const ppl = () => fromTemplate('ppl', id, NOW);
const state = (p: Plan) => ({ v: 1 as const, plans: [p], activeId: p.id });
// 2026-10-19 is a Monday
const MON = '2026-10-19', TUE = '2026-10-20', THU = '2026-10-22', SUN = '2026-10-25';

describe('templates', () => {
  test.each(TEMPLATES.map((t) => t.key))('%s: every exercise is in the library and the plan passes the save checks', (key) => {
    const p = fromTemplate(key, id, NOW);
    expect(planError(p, exercises)).toBeNull();
    for (const r of p.routines) for (const x of r.exercises) expect(exercises.byId(x.exercise_id)).toBeDefined();
    expect(p.days).toHaveLength(7);
  });
  test('Push · Pull · Legs: Mon Push A, Tue Pull A, Wed Legs A, Thu rest, Fri Push B, Sat Pull B, Sun rest (full-b2 train)', () => {
    const p = ppl();
    expect(p.days.map((d) => p.routines.find((r) => r.id === d)?.name ?? 'Rest')).toEqual(['Push A', 'Pull A', 'Legs A', 'Rest', 'Push B', 'Pull B', 'Rest']);
    const push = p.routines[0];
    expect(push.exercises.map((x) => exercises.byId(x.exercise_id)!.name).slice(0, 2)).toEqual(['Bench Press', 'Overhead Barbell Press']);
    expect(targetLabel(push.exercises[0].target)).toBe('4 × 6–8');
    expect(push.exercises[2].target).toBeNull(); // "Add target" rows (plan-builder: targets are optional)
  });
  test('Full body puts the same routine on Mon and Fri (one routine, two days)', () => {
    const p = fromTemplate('fb', id, NOW);
    expect(p.routines.map((r) => r.name)).toEqual(['Full body A', 'Full body B']);
    expect(p.days[0]).toBe(p.days[4]);
    expect(daysLabel(p, p.days[0]!)).toBe('Mon, Fri');
    expect(daysLabel(p, p.days[2]!)).toBe('Wednesdays');
  });
  test('a second plan from the same template gets its own name', () => {
    expect(fromTemplate('ppl', id, NOW, ['Push · Pull · Legs']).name).toBe('Push · Pull · Legs (2)');
    expect(uniqueName('Push A', ['push a', 'Push A (2)'])).toBe('Push A (3)');
    expect(blankPlan(id, NOW).days.every((d) => d === null)).toBe(true);
  });
});

describe('today from the 4 AM log day', () => {
  test('weekday comes from dayOf: 1:30 AM Thursday is still Wednesday', () => {
    const d = dayOf(new Date('2026-10-22T01:30:00+05:30'));
    expect(d).toBe('2026-10-21');
    expect(weekdayOf(d)).toBe(2);
    expect(weekdayOf(dayOf(new Date('2026-10-22T04:00:00+05:30')))).toBe(3);
    expect([MON, SUN].map(weekdayOf)).toEqual([0, 6]);
  });
  test('no active plan → none; a routine day → that routine; a rest day → the next routine', () => {
    expect(todayWorkout(EMPTY_PLANS, MON).kind).toBe('none');
    const p = ppl();
    const tue = todayWorkout(state(p), TUE);
    expect(tue.kind === 'routine' && tue.routine.name).toBe('Pull A');
    const thu = todayWorkout(state(p), THU);
    expect(thu.kind).toBe('rest');
    expect(thu.kind === 'rest' && nextLine(thu.next)).toBe('Next: Push B tomorrow');
    const sun = todayWorkout(state(p), SUN);
    expect(sun.kind === 'rest' && nextLine(sun.next)).toBe('Next: Push A tomorrow');
    const q = { ...p, days: [null, null, null, null, p.days[4], null, null] };
    const mon = todayWorkout(state(q), MON);
    expect(mon.kind === 'rest' && nextLine(mon.next)).toBe('Next: Push B on Fri');
    const empty = todayWorkout(state(blankPlan(id, NOW)), MON);
    expect(empty.kind === 'rest' && nextLine(empty.next)).toBe('No workouts in this plan yet.');
  });
  test('only the active plan counts', () => {
    const p = ppl();
    expect(todayWorkout({ v: 1, plans: [p], activeId: null }, TUE).kind).toBe('none');
  });
  test('split rows: Mon–Sun, today marked, rest days without a routine', () => {
    const rows = splitRows(ppl(), TUE);
    expect(rows.map((r) => `${r.label}:${r.routine?.name ?? 'Rest'}${r.today ? '*' : ''}`)).toEqual(['Mon:Push A', 'Tue:Pull A*', 'Wed:Legs A', 'Thu:Rest', 'Fri:Push B', 'Sat:Pull B', 'Sun:Rest']);
  });
});

describe('labels', () => {
  test('target, rest, minutes and the names line', () => {
    expect(targetLabel({ sets: 3, repsLow: 8, repsHigh: 8 })).toBe('3 × 8');
    expect(targetLabel(null)).toBeNull();
    expect([150, 60, 0, 75].map(restLabel)).toEqual(['rest 2:30', 'rest 1:00', 'no rest', 'rest 1:15']);
    const push = ppl().routines[0];
    // 4×(45+150) + 3×(45+120) + 3×(45+90) + 3×(45+60)×3 = 2625 s ≈ 45 min
    expect(estMinutes(push)).toBe(45);
    expect(estMinutes({ id: 'e', name: 'E', exercises: [] })).toBe(0);
    expect(namesLine(push, exercises, 2)).toBe('Bench Press, Overhead Barbell Press +4');
  });
});

describe('save checks: refuse with a reason, never clamp or drop', () => {
  const ok = (): Routine => ({ id: 'r', name: 'Push A', exercises: [{ exercise_id: 'wger-73', target: { sets: 4, repsLow: 6, repsHigh: 8 }, rest_s: 150 }] });
  test('a good routine passes', () => expect(routineError(ok(), exercises)).toBeNull());
  test.each<[string, (r: Routine) => Routine, string]>([
    ['empty name', (r) => ({ ...r, name: '  ' }), 'Give this routine a name.'],
    ['too long', (r) => ({ ...r, name: 'x'.repeat(LIMITS.name + 1) }), `Keep the name to ${LIMITS.name} characters.`],
    ['no exercises', (r) => ({ ...r, exercises: [] }), 'Add at least one exercise.'],
    ['unknown exercise', (r) => ({ ...r, exercises: [{ ...r.exercises[0], exercise_id: 'gone' }] }), 'One exercise isn’t in the library any more. Remove it to save.'],
    ['reps low > high', (r) => ({ ...r, exercises: [{ ...r.exercises[0], target: { sets: 3, repsLow: 9, repsHigh: 8 } }] }), 'Check the target for Bench Press.'],
    ['fractional sets', (r) => ({ ...r, exercises: [{ ...r.exercises[0], target: { sets: 2.5, repsLow: 8, repsHigh: 8 } }] }), 'Check the target for Bench Press.'],
    ['too many sets', (r) => ({ ...r, exercises: [{ ...r.exercises[0], target: { sets: 11, repsLow: 8, repsHigh: 8 } }] }), 'Check the target for Bench Press.'],
    ['rest off the 15 s step', (r) => ({ ...r, exercises: [{ ...r.exercises[0], rest_s: 100 }] }), 'Check the rest time for Bench Press.'],
    ['rest over 10 min', (r) => ({ ...r, exercises: [{ ...r.exercises[0], rest_s: 615 }] }), 'Check the rest time for Bench Press.'],
  ])('%s', (_n, f, msg) => expect(routineError(f(ok()), exercises)).toBe(msg));
  test('two routines in one plan cannot share a name (case-insensitive)', () => {
    expect(routineError(ok(), exercises, ['push a'])).toBe('This plan already has a routine called Push A.');
  });
  test('a day pointing at a missing routine is refused', () => {
    const p = ppl();
    expect(planError({ ...p, days: ['nope', ...p.days.slice(1)] }, exercises)).toBe('One day points to a routine that isn’t in this plan.');
  });
  test('steppers stop at the limits; reps keep low ≤ high', () => {
    expect(step(10, 1, LIMITS.sets)).toBe(10);
    expect(step(1, -1, LIMITS.sets)).toBe(1);
    expect(step(0, -15, LIMITS.rest)).toBe(0);
    expect(stepReps({ sets: 3, repsLow: 8, repsHigh: 8 }, 'low', 1)).toEqual({ sets: 3, repsLow: 9, repsHigh: 9 });
    expect(stepReps({ sets: 3, repsLow: 6, repsHigh: 8 }, 'high', -1)).toEqual({ sets: 3, repsLow: 6, repsHigh: 7 });
    expect(stepReps({ sets: 3, repsLow: 8, repsHigh: 8 }, 'high', -1)).toEqual({ sets: 3, repsLow: 7, repsHigh: 7 });
  });
  test('delete routine: it comes off every day of the split (those days become rest)', () => {
    const p = fromTemplate('fb', id, NOW);
    const q = removeRoutine(p, p.days[0]!);
    expect(q.days.filter(Boolean)).toHaveLength(1);
    expect(q.routines.map((r) => r.name)).toEqual(['Full body B']);
    expect(planError(q, exercises)).toBeNull();
  });
  test('move and setDay', () => {
    expect(move([1, 2, 3], 0, 1)).toEqual([2, 1, 3]);
    expect(move([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
    expect(setDay(ppl(), 3, null).days[3]).toBeNull();
  });
});

describe('loading from the phone', () => {
  test('anything that is not a plans state loads as empty (the food store, garbage, null)', () => {
    expect(parsePlans(null)).toEqual(EMPTY_PLANS);
    expect(parsePlans('{not json')).toEqual(EMPTY_PLANS);
    expect(parsePlans(JSON.stringify({ entries: [], queue: [] }))).toEqual(EMPTY_PLANS);
  });
  test('a saved plan comes back as saved, even if the library later lost one of its exercises', () => {
    const p = ppl();
    const gone = { ...p, routines: p.routines.map((r, i) => (i ? r : { ...r, exercises: [{ exercise_id: 'gone', target: null, rest_s: 60 }] })) };
    const back = parsePlans(JSON.stringify({ v: 1, plans: [gone], activeId: gone.id }));
    expect(back.plans[0]).toEqual(gone);
    expect(back.activeId).toBe(gone.id);
    expect(parsePlans(JSON.stringify({ v: 1, plans: [p], activeId: 'other' })).activeId).toBeNull();
  });
});

// ---------- store + screens ----------
let plans!: Plans;
function Probe() { plans = usePlans(); return null; }
async function mount(ui: React.ReactElement) {
  let r!: ReactTestRenderer;
  await act(async () => { r = create(<StoreProvider><Probe />{ui}</StoreProvider>); });
  await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
  return r;
}
const byLabel = (r: ReactTestRenderer, l: string | RegExp) => r.root.findAll((x) => typeof x.props.onPress === 'function' && (typeof l === 'string' ? x.props.accessibilityLabel === l : l.test(String(x.props.accessibilityLabel ?? ''))));
const press = (r: ReactTestRenderer, l: string | RegExp) => { const m = byLabel(r, l); if (!m.length) throw new Error(`no ${l}`); return act(async () => { m[0].props.onPress(); }); };
const texts = (r: ReactTestRenderer) => r.root.findAll((x) => typeof x.type === 'string').flatMap((x) => [x.props.children].flat()).filter((c) => typeof c === 'string').join('|');
const saved = () => JSON.parse(mockKv.get(PLANS_KEY) ?? 'null');
beforeEach(() => { mockKv.clear(); mockWrites.length = 0; mockPush.mockClear(); mockBack.mockClear(); });

describe('plans store (LocalStore seam, own key)', () => {
  test('loading never writes; a template is saved under plans-v1 and becomes the active plan', async () => {
    const r = await mount(<></>);
    expect(mockWrites.filter((w) => w === PLANS_KEY)).toEqual([]);
    await act(async () => { plans.applyTemplate('ppl'); });
    expect(saved().plans).toHaveLength(1);
    expect(saved().activeId).toBe(saved().plans[0].id);
    await act(async () => { r.unmount(); });
  });
  test('a refused routine save changes nothing and returns the reason', async () => {
    const r = await mount(<></>);
    let p!: Plan;
    await act(async () => { p = plans.applyTemplate('ppl'); });
    const before = mockKv.get(PLANS_KEY);
    let err: string | null = null;
    await act(async () => { err = plans.saveRoutine(p.id, { ...p.routines[0], name: 'Pull A' }); });
    expect(err).toBe('This plan already has a routine called Pull A.');
    expect(mockKv.get(PLANS_KEY)).toBe(before);
    await act(async () => { r.unmount(); });
  });
  test('the plans survive a restart', async () => {
    let r = await mount(<></>);
    await act(async () => { plans.applyTemplate('ul'); });
    await act(async () => { r.unmount(); });
    r = await mount(<></>);
    expect(plans.state.plans.map((p) => p.name)).toEqual(['Upper · Lower']);
    await act(async () => { r.unmount(); });
  });
});

describe('Today’s workout card (Home / Train)', () => {
  test('no plan: "No plan yet" with Choose a plan → the plan picker', async () => {
    const r = await mount(<TodayCard date={TUE} />);
    expect(texts(r)).toContain('No plan yet');
    expect(texts(r)).toContain('Setup · about 2 min');
    await press(r, 'Choose a plan');
    expect(mockPush).toHaveBeenCalledWith('/train/choose-plan');
    await act(async () => { r.unmount(); });
  });
  test('with Push · Pull · Legs on a Tuesday: Pull A, 6 exercises, ~min, two names +4; Start workout says the logger is next', async () => {
    const r = await mount(<TodayCard date={TUE} />);
    await act(async () => { plans.applyTemplate('ppl'); });
    const s = texts(r);
    expect(s).toContain('Pull A');
    expect(s).toMatch(/6 exercises · ~\d+ min/);
    expect(s).toContain('Deadlifts, Close-grip Lat Pull Down +4');
    await press(r, 'Start workout');
    expect(r.root.findAll((x) => x.props.testID === 'today-card-routine' && typeof x.type === 'string')).toHaveLength(1);
    await act(async () => { r.unmount(); });
  });
  test('rest day (Thursday): "Rest day" and the next routine', async () => {
    const r = await mount(<TodayCard date={THU} />);
    await act(async () => { plans.applyTemplate('ppl'); });
    expect(texts(r)).toContain('Rest day');
    expect(texts(r)).toContain('Next: Push B tomorrow');
    await act(async () => { r.unmount(); });
  });
  test('the notice text for the logger stub', () => expect(LOGGER_SOON).toMatch(/next build/));
});

describe('Train screen', () => {
  test('split card lists Mon–Sun, rest days are not buttons; Plans shows the active tag', async () => {
    const r = await mount(<TrainScreen />);
    await act(async () => { plans.applyTemplate('ppl'); });
    const s = texts(r);
    expect(s).toContain('This week’s split');
    expect(byLabel(r, /^(Mon|Tue|Wed|Fri|Sat)(, today)?: .*Edit routine$/)).toHaveLength(5);
    expect(byLabel(r, /^(Thu|Sun)(, today)?: Rest/)).toHaveLength(0);
    expect(byLabel(r, /^Push · Pull · Legs, 5 days, active\. Open$/)).toHaveLength(1);
    await press(r, /^Mon(, today)?: Push A/);
    expect(mockPush).toHaveBeenLastCalledWith({ pathname: '/train/routine/[id]', params: { id: plans.state.plans[0].days[0], plan: plans.state.plans[0].id } });
    await act(async () => { r.unmount(); });
  });
});

describe('Edit routine screen', () => {
  async function open(day?: number, rid?: string) {
    const r = await mount(<></>);
    let p!: Plan;
    await act(async () => { p = plans.applyTemplate('ppl'); });
    await act(async () => { r.update(<StoreProvider><Probe /><RoutineScreen id={rid ?? p.routines[0].id} planId={p.id} day={day} /></StoreProvider>); });
    return { r, p };
  }
  test('shows the frame: name, Mondays chip, rows with targets or Add target, Search N exercises', async () => {
    const { r } = await open();
    const s = texts(r);
    expect(r.root.findAll((x) => x.type === TextInput)[0].props.value).toBe('Push A');
    expect(s).toContain('Mondays');
    expect(s).toContain('6 exercises · targets are optional');
    expect(s).toContain('4 × 6–8');
    expect(s).toContain('Add target');
    expect(s).toContain(`Search ${exercises.all().length} exercises`);
    await act(async () => { r.unmount(); });
  });
  test('an empty name is refused on Save with the reason; nothing is written', async () => {
    const { r } = await open();
    const before = mockKv.get(PLANS_KEY);
    await act(async () => { r.root.findAll((x) => x.type === TextInput)[0].props.onChangeText(''); });
    await press(r, 'Save routine');
    expect(texts(r)).toContain('Give this routine a name.');
    expect(mockBack).not.toHaveBeenCalled();
    expect(mockKv.get(PLANS_KEY)).toBe(before);
    await act(async () => { r.unmount(); });
  });
  test('add a target, step sets, save: the plan has the new target', async () => {
    const { r, p } = await open();
    await press(r, /^Incline Bench Press - Dumbbell,.*Change$/);
    await press(r, 'Add target for Incline Bench Press - Dumbbell');
    await press(r, 'More sets');
    await press(r, 'Save routine');
    expect(mockBack).toHaveBeenCalled();
    const push = plans.planById(p.id)!.routines[0];
    expect(push.exercises[2].target).toEqual({ sets: 4, repsLow: 10, repsHigh: 10 });
    expect(saved().plans[0].routines[0].exercises[2].target).toEqual({ sets: 4, repsLow: 10, repsHigh: 10 });
    await act(async () => { r.unmount(); });
  });
  test('a new routine for Thursday goes on Thursday when saved', async () => {
    const { r, p } = await open(3, 'new');
    expect(texts(r)).toContain('Thursdays');
    await press(r, /^Add exercise\./);
    await act(async () => { r.root.findAll((x) => x.type === TextInput && x.props.accessibilityLabel === 'Search exercises')[0].props.onChangeText('bench press'); });
    await press(r, /^Add Bench Press, /);
    await press(r, 'Save routine');
    const q = plans.planById(p.id)!;
    expect(q.routines).toHaveLength(6);
    expect(q.routines.find((x) => x.id === q.days[3])!.name).toBe('Thu routine');
    await act(async () => { r.unmount(); });
  });
  test('Delete: the confirm names the day; Delete routine makes it a rest day', async () => {
    const { r, p } = await open();
    await press(r, 'Delete Push A');
    expect(texts(r)).toContain('It comes off your Monday split. Past workouts stay in your history.');
    await press(r, 'Delete routine');
    const q = plans.planById(p.id)!;
    expect(q.days[0]).toBeNull();
    expect(q.routines.map((x) => x.name)).not.toContain('Push A');
    await act(async () => { r.unmount(); });
  });
});
