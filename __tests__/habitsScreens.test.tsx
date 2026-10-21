// Item 14: Habits screen, Create / Edit habit, habit detail (spec §8, §10; CEO Q14/Q17–Q21). Exercise linking is cut.
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
const mockPush = jest.fn(); const mockBack = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ back: mockBack, push: mockPush, replace: jest.fn() }), useSegments: () => ['habits'], useLocalSearchParams: () => ({}) }));

import { Vibration } from 'react-native';
import { addDays, dayOf } from '../src/lib/domain';
import { StoreProvider } from '../src/lib/store';
import { Habits, HABITS_KEY, useHabits } from '../src/lib/habits';
import { ALL_DAYS, Habit, HabitLog, snapOf } from '../src/features/habits/model';
import { HabitForm } from '../src/features/habits/HabitForm';
import { HabitsScreen } from '../src/features/habits/HabitsScreen';
import { HabitDetail, MIN_TOUCH, PAGE_PAD, WEEK_BLEED, WEEK_INSET, weekCellDp } from '../src/features/habits/HabitDetail';
import { HabitToastHost } from '../src/features/habits/HabitToastHost';

const today = dayOf();
let k = 0;
const H = (p: Partial<Habit> & { short_name: string }): Habit => ({ id: `h${++k}`, name: p.short_name, short_name_auto: true, icon: null, kind: 'done', target_value: null, unit: null,
  target_sets: null, target_reps: null, schedule: 'daily', weekdays: ALL_DAYS, starts_on: addDays(today, -30), position: k, archived_at: null, created_at: '', updated_at: '', ...p });
const L = (h: Habit, date: string, p: Partial<HabitLog> = {}): HabitLog => ({ id: `l${++k}`, habit_id: h.id, local_date: date, value: null, done: true, target_snapshot: snapOf(h), logged_at: `${date}T10:00:00Z`, ...p });
const seed = (habits: Habit[], logs: HabitLog[] = []) => mockKv.set(HABITS_KEY, JSON.stringify({ v: 1, habits, logs }));

let hb!: Habits;
function Probe() { hb = useHabits(); return null; }
const texts = (r: ReactTestRenderer) => r.root.findAll((x) => typeof x.type === 'string').flatMap((x) => [x.props.children].flat()).filter((c) => typeof c === 'string').join('|');
const byLabel = (r: ReactTestRenderer, l: string | RegExp) => r.root.findAll((x) => (typeof x.props.onPress === 'function' || typeof x.props.onChangeText === 'function') && (typeof l === 'string' ? x.props.accessibilityLabel === l : l.test(String(x.props.accessibilityLabel ?? ''))));
const press = (r: ReactTestRenderer, l: string | RegExp) => { const m = byLabel(r, l); if (!m.length) throw new Error(`no ${l}`); return act(async () => { m[0].props.onPress(); }); };
const type = (r: ReactTestRenderer, l: string, v: string) => { const m = byLabel(r, l); if (!m.length) throw new Error(`no ${l}`); return act(async () => { m[0].props.onChangeText(v); }); };
async function mount(el: React.ReactElement) {
  let r!: ReactTestRenderer;
  await act(async () => { r = create(<StoreProvider><Probe />{el}<HabitToastHost /></StoreProvider>); });
  await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
  return r;
}
beforeEach(() => { mockKv.clear(); mockPush.mockClear(); mockBack.mockClear(); jest.spyOn(Vibration, 'vibrate').mockImplementation(() => {}); });

describe('Create habit', () => {
  test('short name follows the name and previews it; Count target with unit; Save creates it (starts today, last in order)', async () => {
    seed([H({ short_name: 'Read' })]);
    const r = await mount(<HabitForm />);
    expect(texts(r)).toContain('New habit');
    expect(texts(r)).not.toMatch(/Link to an exercise/);
    await type(r, 'Name', 'Water 8 glasses');
    expect(byLabel(r, 'Short name, shown on Home')[0].props.value).toBe('Water');
    expect(r.root.findAll((x) => x.props.accessibilityLabel === 'Large text preview: Water')).not.toHaveLength(0);
    await press(r, 'Count');
    expect(texts(r)).toContain('8 glasses');
    await press(r, 'Unit, glasses. Change unit');
    await press(r, 'pages');
    await press(r, 'More target (pages)');
    expect(texts(r)).toContain('9 pages');
    await press(r, 'Save habit');
    const h = hb.state.habits.find((x) => x.name === 'Water 8 glasses')!;
    expect([h.short_name, h.kind, h.target_value, h.unit, h.icon, h.starts_on, h.position]).toEqual(['Water', 'count', 9, 'pages', 'drop', today, 2]);
    expect(mockBack).toHaveBeenCalled();
    await act(async () => { r.unmount(); });
  });
  test('a Count target defaults to "times" (not glass); Water suggests glasses; a typed unit wins and saves trimmed', async () => {
    seed([]);
    const r = await mount(<HabitForm />);
    await type(r, 'Name', 'Pray');
    await press(r, 'Count');
    expect(texts(r)).toContain('8 times');
    expect(texts(r)).not.toMatch(/glass/);
    await type(r, 'Name', 'Drink water');
    expect(texts(r)).toContain('8 glasses');
    await type(r, 'Unit, optional', ' big cups ');
    await type(r, 'Name', 'Drink water daily');
    expect(texts(r)).toContain('8 big cups');
    await type(r, 'Unit, optional', '');
    expect(texts(r)).toContain('8 times');
    await type(r, 'Unit, optional', 'laps ');
    await press(r, 'Save habit');
    expect(hb.state.habits.find((x) => x.name === 'Drink water daily')!.unit).toBe('laps');
    await act(async () => { r.unmount(); });
  });
  test('editing a habit saved with "glass" keeps it as stored (no silent rewrite); renaming it doesn\u2019t change the unit', async () => {
    const g = H({ short_name: 'Pray', kind: 'count', target_value: 5, unit: 'glass' });
    seed([g]);
    function Later() { return useHabits().habitById(g.id) ? <HabitForm id={g.id} /> : null; } // as in the app: Edit opens once habits have loaded
    const r = await mount(<Later />);
    expect(texts(r)).toContain('5 glass');
    expect(byLabel(r, 'Unit, optional')[0].props.value).toBe('glass');
    await type(r, 'Name', 'Pray water');
    await press(r, 'Save habit');
    expect(hb.state.habits.find((x) => x.id === g.id)!.unit).toBe('glass');
    await act(async () => { r.unmount(); });
  });
  test('too long for Home and clashes are flagged live, and Save refuses with the reason', async () => {
    seed([H({ short_name: 'Push-ups' })]);
    const r = await mount(<HabitForm />);
    await type(r, 'Name', 'Meditation 10 min');
    await type(r, 'Short name, shown on Home', 'Meditation');
    expect(texts(r)).toContain('Too long for Home. Try a shorter name.');
    await type(r, 'Short name, shown on Home', 'push ups');
    expect(texts(r)).toContain('Already used, pick another');
    await press(r, 'Save habit');
    expect(hb.state.habits).toHaveLength(1);
    expect(mockBack).not.toHaveBeenCalled();
    // once edited, the name no longer changes the short name
    await type(r, 'Short name, shown on Home', 'Calm');
    await type(r, 'Name', 'Meditate 10 min each morning');
    expect(byLabel(r, 'Short name, shown on Home')[0].props.value).toBe('Calm');
    await act(async () => { r.unmount(); });
  });
  test('weak derive is highlighted with a hint; Pick days needs a day', async () => {
    const r = await mount(<HabitForm />);
    await type(r, 'Name', 'Call grandparents on weekends');
    expect(byLabel(r, 'Short name, shown on Home')[0].props.value).toBe('Call');
    expect(texts(r)).toContain('Pick a short name, like Gran.'); // "Grandma" is 89dp at 1.3×, too wide for the slot
    await type(r, 'Short name, shown on Home', 'Grandma');
    expect(texts(r)).toContain('Too long for Home. Try a shorter name.');
    await type(r, 'Short name, shown on Home', 'Gran');
    await press(r, 'Pick days');
    for (const d of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) await press(r, d);
    expect(texts(r)).toContain('Pick at least one day.');
    await press(r, 'Sat'); await press(r, 'Sun');
    await press(r, 'Save habit');
    const h = hb.state.habits[0];
    expect([h.short_name, h.schedule, h.weekdays]).toEqual(['Gran', 'days', 0b1100000]);
    await act(async () => { r.unmount(); });
  });
});

describe('Habits screen', () => {
  test('"1 of 3 done"; not done first in user order, done last; sub lines; tap ticks; › opens; Not today', async () => {
    const w = H({ short_name: 'Water', name: 'Water', kind: 'count', target_value: 8, unit: 'glasses' });
    const p = H({ short_name: 'Push-ups', name: 'Incline push-ups', kind: 'sets', target_sets: 3, target_reps: 15 });
    const rd = H({ short_name: 'Read', name: 'Read 10 pages' });
    const off = H({ short_name: 'Off', name: 'Never today', schedule: 'days', weekdays: ALL_DAYS & ~(1 << ((new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7)) });
    seed([rd, w, p, off], [L(rd, today), L(rd, addDays(today, -1)), L(w, today, { done: false, value: 5 })]);
    const r = await mount(<HabitsScreen />);
    const tx = texts(r);
    expect(tx).toMatch(/· 1 of 3 done/);
    const order = r.root.findAll((x) => typeof x.type === 'string' && /^row-/.test(String(x.props.testID ?? ''))).map((x) => String(x.props.testID).slice(4));
    expect(order).toEqual(['Water', 'Push-ups', 'Read', 'Off']);
    expect(tx).toContain('5 of 8 glasses');
    expect(tx).toContain('3 × 15');
    expect(tx).toContain('2 days');
    expect(tx).toContain('Not today');
    await press(r, 'Incline push-ups, 3 × 15, not done yet. Double-tap to mark done');
    expect(hb.state.logs.find((l) => l.habit_id === p.id)?.done).toBe(true);
    expect(texts(r)).toContain('Push-ups done');
    expect(byLabel(r, 'Change amount')).toHaveLength(1);
    await press(r, 'Open Water');
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/habit/[id]', params: { id: w.id } });
    await act(async () => { r.unmount(); });
  });
  test('empty state', async () => {
    const r = await mount(<HabitsScreen />);
    expect(texts(r)).toContain('No habits yet');
    await act(async () => { r.unmount(); });
  });
});

describe('Habit detail', () => {
  test('meta, streak, Today tick, late log a past day, history, edit keeps past snapshots, archive', async () => {
    const p = H({ short_name: 'Push-ups', name: 'Incline push-ups', kind: 'sets', target_sets: 3, target_reps: 15, starts_on: addDays(today, -20) });
    const days = [1, 2, 3].map((i) => addDays(today, -i));
    seed([p], days.map((d) => L(p, d)));
    const r = await mount(<HabitDetail id={p.id} />);
    let tx = texts(r);
    expect(tx).toContain('Incline push-ups');
    expect(tx).toContain('3 sets × 15 reps · Every day');
    expect(tx).toContain('3 days');
    expect(r.root.findAll((x) => x.props.accessibilityLabel === '3 days in a row')).not.toHaveLength(0);
    expect(tx).not.toMatch(/free|forgiv/i);
    await press(r, /^Today, Incline push-ups, 3 × 15, not done yet/);
    expect(texts(r)).toContain('4 days');
    // History lists the days
    await press(r, 'History');
    expect(r.root.findAll((x) => typeof x.type === 'string' && x.props.testID === 'habit-history')).toHaveLength(1);
    // Edit a target: past logs keep their snapshot
    await act(async () => { hb.update(p.id, { name: p.name, short_name: p.short_name, short_name_auto: true, icon: null, kind: 'sets', target_value: 8, unit: 'glasses', target_sets: 4, target_reps: 10, schedule: 'daily', weekdays: ALL_DAYS }); });
    expect(hb.state.logs.find((l) => l.local_date === days[0])!.target_snapshot.sets).toBe(3);
    expect(texts(r)).toContain('4 sets × 10 reps · Every day');
    // Log a different amount (today is done at 3 × 15 → set it to 2 of 3)
    await press(r, 'Log a different amount');
    await press(r, 'Less sets done');
    await press(r, 'Save amount');
    tx = texts(r);
    expect(tx).toContain('2 of 3 sets');
    await press(r, 'Archive habit');
    await press(r, 'Archive');
    expect(hb.state.habits[0].archived_at).not.toBeNull();
    expect(hb.state.logs.length).toBe(4); // history kept
    expect(mockBack).toHaveBeenCalled();
    await act(async () => { r.unmount(); });
  });
  test('late logging: a missed day this week can be tapped within 7 days', async () => {
    const h = H({ short_name: 'Read', starts_on: addDays(today, -30) });
    seed([h]);
    const r = await mount(<HabitDetail id={h.id} />);
    const missed = r.root.findAll((x) => typeof x.props.onPress === 'function' && /missed\. Double-tap to log it$/.test(String(x.props.accessibilityLabel ?? '')));
    if (missed.length) {
      await act(async () => { missed[0].props.onPress(); });
      expect(hb.state.logs).toHaveLength(1);
      expect(hb.state.logs[0].local_date < today).toBe(true);
    } else {
      expect(new Date(today + 'T00:00:00Z').getUTCDay()).toBe(1); // only Monday has no past day this week
    }
    await act(async () => { r.unmount(); });
  });
  test('Tester O3: the This week days are 48dp touch targets on a 360dp phone, squares about the same size as before', async () => {
    expect(weekCellDp(360)).toBeGreaterThanOrEqual(48);
    expect(weekCellDp(360) - 2 * WEEK_INSET).toBeGreaterThan((360 - 2 * PAGE_PAD - 6 * 6) / 7); // was ≈ 40.6dp
    const h = H({ short_name: 'Read', starts_on: addDays(today, -30) });
    seed([h]);
    const r = await mount(<HabitDetail id={h.id} />);
    const flat = (st: unknown) => Object.assign({}, ...[st].flat(9).filter(Boolean));
    const row = r.root.findAll((x) => typeof x.type === 'string' && x.props.testID === 'week-row')[0];
    expect(flat(row.props.style)).toMatchObject({ flexDirection: 'row', marginHorizontal: -WEEK_BLEED });
    expect(flat(row.props.style).gap).toBeUndefined(); // no dead gaps between targets
    const days = r.root.findAll((x) => typeof x.type === 'string' && /^day-\d{4}-\d\d-\d\d$/.test(String(x.props.testID ?? '')));
    expect(days).toHaveLength(7);
    for (const d of days) expect(flat(d.props.style)).toMatchObject({ width: '100%', minHeight: MIN_TOUCH, padding: WEEK_INSET });
    await act(async () => { r.unmount(); });
  });
});
