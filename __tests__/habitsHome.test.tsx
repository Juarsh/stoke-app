// Item 13: Habits B2 on Home (spec §7, §8, §10.3 streak; CEO Q7/Q9/Q14/Q21). Model: due days, B2 order (undone first in
// user order, then most recently done), 3 slots + "+N", all done, the streak's silent free miss, the short-name rule
// (derive, 74dp fit at 1.3×, uniqueness), save checks (refuse with a reason). Screen: tick with Undo / Change, the row
// holds still while a toast is up and settles 4 s after it closes, TalkBack labels and the Details action, 4 AM day.
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
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn(), push: mockPush, replace: jest.fn() }), useSegments: () => ['(tabs)'] }));

import { Vibration } from 'react-native';
import { dayOf } from '../src/lib/domain';
import { StoreProvider } from '../src/lib/store';
import { Habits, HABITS_KEY, SETTLE_MS, useHabits } from '../src/lib/habits';
import {
  ALL_DAYS, blankDraft, deriveShort, draftErrors, Habit, HabitLog, HabitsState, homeA11y, homeOrder, homeRow, isDue, KEYWORD_SHORTS, metaLine, partialText,
  parseHabits, snapOf, streak, textWidth, tooWide, weekCells,
} from '../src/features/habits/model';
import { HabitsCard } from '../src/features/habits/HabitsCard';
import { HabitToastHost } from '../src/features/habits/HabitToastHost';

let k = 0;
const H = (p: Partial<Habit> & { short_name: string }): Habit => ({ id: `h${++k}`, name: p.short_name, short_name_auto: true, icon: null, kind: 'done', target_value: null, unit: null,
  target_sets: null, target_reps: null, schedule: 'daily', weekdays: ALL_DAYS, starts_on: '2026-01-01', position: k, archived_at: null, created_at: '', updated_at: '', ...p });
const L = (h: Habit, date: string, at = `${date}T10:00:00Z`, p: Partial<HabitLog> = {}): HabitLog => ({ id: `l${++k}`, habit_id: h.id, local_date: date, value: null, done: true,
  target_snapshot: snapOf(h), logged_at: at, ...p });
const S = (habits: Habit[], logs: HabitLog[] = []): HabitsState => ({ v: 1, habits, logs });
const D = '2026-10-21'; // Wednesday

describe('due days and the B2 row', () => {
  const [a, b, c, d, e] = ['Push-ups', 'Read', 'Guitar', 'Water', 'No sugar'].map((n) => H({ short_name: n }));
  test('off days, archived and not-started habits are not due', () => {
    expect(isDue(H({ short_name: 'x', schedule: 'weekdays', weekdays: 31 }), '2026-10-24')).toBe(false); // Sat
    expect(isDue(H({ short_name: 'x', schedule: 'days', weekdays: 0b0000100 }), D)).toBe(true); // Wed
    expect(isDue(H({ short_name: 'x', archived_at: 'z' }), D)).toBe(false);
    expect(isDue(H({ short_name: 'x', starts_on: '2026-10-22' }), D)).toBe(false);
  });
  test('3 slots + "+N"; undone first in user order; done most recent first; partial counts as undone', () => {
    const s = S([a, b, c, d, e], [L(a, D, `${D}T08:00:00Z`), L(c, D, `${D}T09:00:00Z`), L(d, D, `${D}T09:30:00Z`, { done: false, value: 5 })]);
    expect(homeOrder(s, D)).toEqual([b.id, d.id, e.id, c.id, a.id]);
    expect(homeRow(s, D)).toEqual({ kind: 'row', ids: [b.id, d.id, e.id], more: 2, total: 5 });
  });
  test('mostly done: 1 undone, then the 2 most recently done', () => {
    const s = S([a, b, c, d], [L(a, D, `${D}T08:00:00Z`), L(b, D, `${D}T09:00:00Z`), L(c, D, `${D}T10:00:00Z`)]);
    expect(homeRow(s, D).ids).toEqual([d.id, c.id, b.id]);
  });
  test('fewer than 3 share the row; none; all done', () => {
    expect(homeRow(S([a, b]), D)).toEqual({ kind: 'row', ids: [a.id, b.id], more: 0, total: 2 });
    expect(homeRow(S([]), D).kind).toBe('none');
    expect(homeRow(S([a, b], [L(a, D), L(b, D)]), D)).toEqual({ kind: 'all-done', ids: [], more: 0, total: 2 });
  });
  test('labels', () => {
    const p = H({ short_name: 'Push-ups', name: 'Incline push-ups', kind: 'sets', target_sets: 3, target_reps: 12 });
    expect(homeA11y(p, false)).toBe('Push-ups, Incline push-ups 3 by 12, not done. Double-tap to mark done');
    expect(homeA11y(H({ short_name: 'Water' }), true)).toBe('Water, done');
    expect(metaLine(p)).toBe('3 sets × 12 reps · Every day');
    const w = H({ short_name: 'Water', kind: 'count', target_value: 8, unit: 'glasses', schedule: 'days', weekdays: 0b0010101 });
    expect(metaLine(w)).toBe('8 glasses · Mon, Wed, Fri');
    expect(partialText(L(w, D, undefined, { done: false, value: 5 }))).toBe('5 of 8 glasses');
  });
});

describe('streak', () => {
  const h = H({ short_name: 'Read', starts_on: '2026-10-01' });
  const days = (...ds: string[]) => S([h], ds.map((x) => L(h, x)));
  test('consecutive due days; today counts once done and doesn\'t break it before', () => {
    expect(streak(days('2026-10-19', '2026-10-20'), h, D)).toBe(2);
    expect(streak(days('2026-10-19', '2026-10-20', D), h, D)).toBe(3);
  });
  test('one miss per Mon–Sun week is forgiven; a second resets', () => {
    // Mon 19 missed, Tue 20 done, (Sun 18, Sat 17 done) → 3
    expect(streak(days('2026-10-17', '2026-10-18', '2026-10-20'), h, D)).toBe(3);
    // Mon 19 and Tue 20 both missed → 0
    expect(streak(days('2026-10-17', '2026-10-18'), h, D)).toBe(0);
    // a miss in each of two weeks is fine
    expect(streak(days('2026-10-20', '2026-10-18', '2026-10-17', '2026-10-15'), h, D)).toBe(4);
  });
  test('days not due are skipped; stops at the start date', () => {
    const wd = H({ short_name: 'Gym', schedule: 'weekdays', weekdays: 31, starts_on: '2026-10-16' });
    const s = S([wd], ['2026-10-16', '2026-10-19', '2026-10-20'].map((x) => L(wd, x)));
    expect(streak(s, wd, D)).toBe(3);
  });
  // Tester O1 (444633c) + CEO rule: habits due N < 7 days a week need N completions in every completed Mon–Sun week
  test('daily keeps the one-forgiven-miss rule: two misses in a row always break it', () => {
    expect(streak(days('2026-10-15', '2026-10-16', '2026-10-17', '2026-10-20'), h, D)).toBe(4); // Sun 18 missed alone: forgiven
    expect(streak(days('2026-10-15', '2026-10-16', '2026-10-17'), h, D)).toBe(0); // Sun 18 (last week) + Mon 19 + Tue 20
    expect(streak(days('2026-10-12', '2026-10-13', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20'), h, D)).toBe(5); // Wed 14 + Thu 15
  });
  const sun = H({ short_name: 'Long run', schedule: 'days', weekdays: 0b1000000, starts_on: '2026-06-01' });
  const sundays = (...ds: string[]) => S([sun], ds.map((x) => L(sun, x)));
  test('Sundays only: 4 Sundays ticked then 12 skipped → 0 (it used to stay 4 for ever)', () => {
    expect(streak(sundays('2026-07-05', '2026-07-12', '2026-07-19', '2026-07-26'), sun, D)).toBe(0);
    // ticked through last Sunday: 4, and this week (its Sunday still ahead) can't break it
    expect(streak(sundays('2026-09-27', '2026-10-04', '2026-10-11', '2026-10-18'), sun, D)).toBe(4);
    expect(streak(sundays('2026-09-27', '2026-10-04', '2026-10-11', '2026-10-18', '2026-10-25'), sun, '2026-10-25')).toBe(5);
    // one skipped Sunday in the middle breaks it at that week
    expect(streak(sundays('2026-09-27', '2026-10-11', '2026-10-18'), sun, D)).toBe(2);
  });
  test('the week ends at 4 AM on Monday (dayOf): Sunday not ticked still counts the past until then', () => {
    const s = sundays('2026-10-04', '2026-10-11', '2026-10-18');
    expect(streak(s, sun, dayOf(new Date('2026-10-25T23:30:00+05:30')))).toBe(3);
    expect(streak(s, sun, dayOf(new Date('2026-10-26T03:59:00+05:30')))).toBe(3); // still Sunday's log day
    expect(streak(s, sun, dayOf(new Date('2026-10-26T04:00:00+05:30')))).toBe(0); // the week ended without its Sunday
  });
  test('weekdays: every completed week needs all 5; the current week never breaks it; weekends don\'t count', () => {
    const wd = H({ short_name: 'Gym', schedule: 'weekdays', weekdays: 31, starts_on: '2026-10-01' });
    const on = (...ds: string[]) => S([wd], ds.map((x) => L(wd, x)));
    const lastWeek = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'];
    expect(streak(on(...lastWeek, '2026-10-20'), wd, D)).toBe(6); // Mon 19 missed this week: not over yet
    expect(streak(on(...lastWeek, '2026-10-18', '2026-10-20'), wd, D)).toBe(6); // a Sunday tick isn't a due day
    expect(streak(on('2026-10-12', '2026-10-13', '2026-10-15', '2026-10-16', '2026-10-19', '2026-10-20'), wd, D)).toBe(2); // Wed 14 missed
    // start week: only the due days on or after starts_on (Thu 1, Fri 2) are needed
    expect(streak(on('2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', ...lastWeek), wd, D)).toBe(12);
  });
  test('2 days a week (Mon, Thu): never doing Thursday breaks it', () => {
    const mt = H({ short_name: 'Yoga', schedule: 'days', weekdays: 0b0001001, starts_on: '2026-09-01' });
    const on = (...ds: string[]) => S([mt], ds.map((x) => L(mt, x)));
    expect(streak(on('2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19'), mt, D)).toBe(1);
    expect(streak(on('2026-10-05', '2026-10-08', '2026-10-12', '2026-10-15', '2026-10-19'), mt, D)).toBe(5);
  });
  test('week squares: done, today, future, missed (warm grey), before the start date', () => {
    const n = H({ short_name: 'New', starts_on: '2026-10-20' });
    const cells = weekCells(S([n], [L(n, '2026-10-20')]), n, D).map((c) => c.cell);
    expect(cells).toEqual(['before', 'done', 'today', 'future', 'future', 'future', 'future']);
    const m = H({ short_name: 'M', starts_on: '2026-10-01' });
    expect(weekCells(S([m]), m, D)[0].cell).toBe('missed');
  });
});

describe('short name (§8)', () => {
  test('fit is measured on the DM Sans Bold table (B2 notes numbers)', () => {
    expect(Math.round(textWidth('Push-ups', 15))).toBe(71);
    expect(Math.round(textWidth('Meditation', 19.5))).toBe(105);
    expect(tooWide('Push-ups')).toBeNull(); // wraps at the hyphen: 58 + 35
    expect(tooWide('No sugar')).toBeNull();
    expect(tooWide('Meditation')).toBe('Meditation');
  });
  test('every keyword short name passes the fit check (build-time check)', () => {
    for (const s of KEYWORD_SHORTS) expect([s, tooWide(s)]).toEqual([s, null]);
  });
  test('derive: examples from the spec', () => {
    expect(deriveShort('Incline push-ups 3×12').short).toBe('Push-ups');
    expect(deriveShort('Water 8 glasses').short).toBe('Water');
    expect(deriveShort('Read 20 min')).toEqual({ short: 'Read', icon: 'book', weak: false });
    expect(deriveShort('Call mom')).toEqual({ short: 'Call mom', icon: 'phone', weak: false });
    expect(deriveShort('Call grandparents on weekends')).toEqual({ short: 'Call', icon: 'phone', weak: true });
    expect(deriveShort('No sugar after 8 PM').short).toBe('No sugar after');
    expect(deriveShort('Guitar practice daily').short).toBe('Guitar'); // "practice" is 79dp at 1.3×
    expect(deriveShort('Floss').icon).toBeNull(); // monogram
  });
  test('checks: required, 16 chars, too long for Home, clash (case, spaces, hyphens), targets, days', () => {
    const base = { ...blankDraft(), name: 'Incline push-ups', short_name: 'Push-ups' };
    expect(draftErrors(base, [])).toEqual({});
    expect(draftErrors({ ...base, name: ' ' }, []).name).toBe('Enter a name.');
    expect(draftErrors({ ...base, name: 'x'.repeat(41) }, []).name).toBe('Name can be at most 40 characters.');
    expect(draftErrors({ ...base, short_name: '' }, []).short).toBe('Enter a short name for Home.');
    expect(draftErrors({ ...base, short_name: 'A b c d e f g h i' }, []).short).toBe('Short name can be at most 16 characters.');
    expect(draftErrors({ ...base, short_name: 'Meditation' }, []).short).toBe('Too long for Home. Try a shorter name.');
    expect(draftErrors({ ...base, short_name: 'push ups' }, [H({ short_name: 'Push-ups' })]).short).toBe('Already used, pick another');
    expect(draftErrors({ ...base, short_name: 'Call' }, [H({ short_name: 'Call mom' })]).short).toBeUndefined(); // exact match only
    expect(draftErrors({ ...base, short_name: 'Push-ups' }, [H({ short_name: 'Push-ups', archived_at: 'x' })]).short).toBeUndefined();
    expect(draftErrors({ ...base, kind: 'count', target_value: 0 }, []).target).toBe('Target must be a whole number from 1 to 999.');
    expect(draftErrors({ ...base, kind: 'count', target_value: 2.5 }, []).target).toBe('Target must be a whole number from 1 to 999.');
    expect(draftErrors({ ...base, kind: 'count', unit: 'steps' }, []).target).toBe('Steps are on the Food card, so they can’t be a habit.');
    expect(draftErrors({ ...base, kind: 'sets', target_sets: 21 }, []).target).toBe('Sets must be 1 to 20 and reps 1 to 200.');
    expect(draftErrors({ ...base, schedule: 'days', weekdays: 0 }, []).days).toBe('Pick at least one day.');
  });
  test('parse: junk → empty; logs of unknown habits dropped', () => {
    expect(parseHabits('nope')).toEqual({ v: 1, habits: [], logs: [] });
    const h = H({ short_name: 'R' });
    expect(parseHabits(JSON.stringify(S([h], [L(h, D), { ...L(h, D), habit_id: 'gone' }]))).logs).toHaveLength(1);
  });
});

// ---- Home card ---------------------------------------------------------------------------------------------------
let hb!: Habits;
function Probe() { hb = useHabits(); return null; }
const texts = (r: ReactTestRenderer) => r.root.findAll((x) => typeof x.type === 'string').flatMap((x) => [x.props.children].flat()).filter((c) => typeof c === 'string').join('|');
const byLabel = (r: ReactTestRenderer, l: string | RegExp) => r.root.findAll((x) => typeof x.props.onPress === 'function' && (typeof l === 'string' ? x.props.accessibilityLabel === l : l.test(String(x.props.accessibilityLabel ?? ''))));
const press = (r: ReactTestRenderer, l: string | RegExp) => { const m = byLabel(r, l); if (!m.length) throw new Error(`no ${l}`); return act(async () => { m[0].props.onPress(); }); };
const slotOrder = (r: ReactTestRenderer) => r.root.findAll((x) => typeof x.type === 'string' && /^habit-/.test(String(x.props.testID ?? ''))).map((x) => String(x.props.testID).slice(6));
async function mount(today: string) {
  let r!: ReactTestRenderer;
  await act(async () => { r = create(<StoreProvider><Probe /><HabitsCard date={today} /><HabitToastHost /></StoreProvider>); });
  await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
  return r;
}
beforeEach(() => { mockKv.clear(); mockPush.mockClear(); jest.useRealTimers(); });

describe('Home habits card', () => {
  const today = dayOf();
  const five = () => ['Push-ups', 'Read', 'Guitar', 'Water', 'No sugar'].map((n, i) => H({ short_name: n, name: n === 'Water' ? 'Water 8 glasses' : n, position: i,
    ...(n === 'Water' ? { kind: 'count' as const, target_value: 8, unit: 'glasses' } : {}) }));
  test('none → "+ Add habit"; header has no counter', async () => {
    const r = await mount(today);
    expect(texts(r)).toContain('Add habit');
    await press(r, 'Add habit'); expect(mockPush).toHaveBeenCalledWith('/habit-form');
    await act(async () => { r.unmount(); });
  });
  test('3 slots + More "+2"; tick holds the row while the toast is up, settles 4 s after it closes; Undo restores', async () => {
    const hs = five(); mockKv.set(HABITS_KEY, JSON.stringify(S(hs)));
    const vib = jest.spyOn(Vibration, 'vibrate').mockImplementation(() => {});
    const r = await mount(today);
    expect(slotOrder(r)).toEqual(['Push-ups', 'Read', 'Guitar']);
    expect(byLabel(r, '2 more habits, open Habits')).toHaveLength(1);
    expect(texts(r)).not.toMatch(/\d of \d/); // no counter, no targets on Home
    jest.useFakeTimers();
    await press(r, /^Push-ups, Push-ups, not done/);
    expect(vib).toHaveBeenCalledWith(15);
    expect(texts(r)).toContain('Push-ups done');
    expect(byLabel(r, 'Change amount')).toHaveLength(0); // yes / no: no Change (Q9)
    expect(slotOrder(r)).toEqual(['Push-ups', 'Read', 'Guitar']); // held
    expect(byLabel(r, 'Push-ups, done')).toHaveLength(1);
    await act(async () => { jest.advanceTimersByTime(4000); }); // toast closes
    expect(texts(r)).not.toContain('Push-ups done');
    expect(slotOrder(r)).toEqual(['Push-ups', 'Read', 'Guitar']); // still held
    await act(async () => { jest.advanceTimersByTime(SETTLE_MS); });
    expect(slotOrder(r)).toEqual(['Read', 'Guitar', 'Water']); // settled: Push-ups went into More
    // Undo: tick Read then Undo → Read back undone, same spot
    await press(r, /^Read, Read, not done/);
    await press(r, 'Undo, Read done');
    expect(hb.state.logs.filter((l) => l.done).map((l) => l.habit_id)).toEqual([hs[0].id]);
    await act(async () => { jest.advanceTimersByTime(SETTLE_MS + 10); });
    expect(slotOrder(r)).toEqual(['Read', 'Guitar', 'Water']);
    jest.useRealTimers(); vib.mockRestore();
    await act(async () => { r.unmount(); });
  });
  test('Change (count): "5 of 8 glasses" stays undone; Details action opens the habit', async () => {
    const hs = five(); mockKv.set(HABITS_KEY, JSON.stringify(S(hs)));
    jest.spyOn(Vibration, 'vibrate').mockImplementation(() => {});
    const r = await mount(today);
    await act(async () => { hb.toggle(hs[3].id, today, today); });
    await press(r, 'Change amount');
    expect(texts(r)).toContain('8 of 8 glasses');
    for (let i = 0; i < 3; i++) await press(r, 'Less amount (glasses)');
    await press(r, 'Save amount');
    const log = hb.state.logs.find((l) => l.habit_id === hs[3].id)!;
    expect([log.done, log.value]).toEqual([false, 5]);
    const item = r.root.findAll((x) => typeof x.props.onAccessibilityAction === 'function' && String(x.props.accessibilityLabel).startsWith('Push-ups'))[0];
    await act(async () => { item.props.onAccessibilityAction({ nativeEvent: { actionName: 'details' } }); });
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/habit/[id]', params: { id: hs[0].id } });
    await act(async () => { r.unmount(); });
  });
  test('all done → "All 2 done"; late logging refuses older than 7 days with a reason', async () => {
    const hs = five().slice(0, 2); mockKv.set(HABITS_KEY, JSON.stringify(S(hs, hs.map((h) => L(h, today)))));
    const r = await mount(today);
    expect(texts(r)).toContain('All 2 done');
    let err: string | null = null;
    await act(async () => { err = hb.toggle(hs[0].id, '2020-01-01', today); });
    expect(err).toBe('You can log up to 7 days back.');
    await act(async () => { r.unmount(); });
  });
});
