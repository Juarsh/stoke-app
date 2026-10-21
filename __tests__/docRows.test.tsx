// M4 doc sync, pure parts + the off switch: what is queued after a change, how a 409 / refusal / delete elsewhere and a
// pull land on the phone, and that a build without EXPO_PUBLIC_API_URL never queues or sends anything.
import React from 'react';
import { act, create } from 'react-test-renderer';

const mockMem: Record<string, string> = {};
jest.mock('../src/lib/kv', () => ({ kv: { get: async (k: string) => mockMem[k] ?? null, set: async (k: string, v: string) => { mockMem[k] = v; } } }));
jest.mock('expo-crypto', () => ({ randomUUID: (() => { let n = 0; return () => `id-${n++}`; })() }));

import { bodies, diff, EMPTY_LEDGER, habitBody, landPull, landResult, logKey, type Local } from '../src/lib/docRows';
import { exercises } from '../src/lib/exercises';
import { EMPTY_PLANS } from '../src/features/plans/model';
import { EMPTY_WORKOUTS } from '../src/features/workout/model';
import type { Habit, HabitLog } from '../src/features/habits/model';
import { StoreProvider, useStore, Store } from '../src/lib/store';
import { DocSync } from '../src/lib/DocSync';
import { useHabits, Habits } from '../src/lib/habits';
import { blankDraft } from '../src/features/habits/model';

const habit = (id: string, short: string): Habit => ({ id, name: short, short_name: short, short_name_auto: false, icon: null, kind: 'done', target_value: null, unit: null,
  target_sets: null, target_reps: null, schedule: 'daily', weekdays: 127, starts_on: '2026-10-01', position: 0, archived_at: null, created_at: '', updated_at: '' });
const log = (hid: string, date: string): HabitLog => ({ id: `l-${hid}-${date}`, habit_id: hid, local_date: date, value: null, done: true,
  target_snapshot: { kind: 'done', value: null, unit: null, sets: null, reps: null }, logged_at: '2026-10-20T05:00:00Z' });
const local = (hs: Habit[], ls: HabitLog[] = []): Local => ({ plans: EMPTY_PLANS, workouts: EMPTY_WORKOUTS, habits: { v: 1, habits: hs, logs: ls } });
const row = (h: Habit, version: number) => ({ ...habitBody(h), id: h.id, version, created_at: 'c', updated_at: 'u' });

test('diff: changed bodies are PUT (habits before their logs), gone ones DELETEd (logs first); unchanged ones are not sent', () => {
  const s = local([habit('a', 'A'), habit('b', 'B')], [log('a', '2026-10-20')]);
  const b = bodies(s, exercises);
  const sent = { 'habit:b': JSON.stringify(b['habit:b']), 'habit:gone': '{}', [logKey(log('gone', '2026-10-19'))]: '{}' };
  expect(diff(b, sent).map((c) => [c.key, !!c.body])).toEqual([['habit:a', true], ['habitLog:a/2026-10-20', true], ['habitLog:gone/2026-10-19', false], ['habit:gone', false]]);
  // the workout in progress never syncs; finished ones do
  expect(Object.keys(bodies({ ...s, workouts: { ...EMPTY_WORKOUTS, active: { id: 'w', title: 'x', plan_id: null, routine_id: null, local_date: '2026-10-20', started_at: '', ended_at: null, exercises: [] } } }, exercises)).some((k) => k.startsWith('workout'))).toBe(false);
});

test('a flush answer: 409 -> the server row (and its version); refused -> kept with the reason; gone -> removed', () => {
  const s = local([habit('a', 'Walk'), habit('b', 'Read'), habit('c', 'Calm')], [log('c', '2026-10-20')]);
  const l = landResult(s, { saved: [], stale: [{ key: 'habit:a', row: row(habit('a', 'Stroll'), 3), reason: 'Changed on another device. Showing the saved version.' }],
    failed: [{ key: 'habit:b', code: 'invalid', reason: 'Already used, pick another' }], gone: ['habit:c'] }, exercises);
  expect(l.local.habits.habits.map((h) => h.short_name)).toEqual(['Stroll', 'Read']);
  expect(l.local.habits.logs).toEqual([]); // the deleted habit took its logs
  expect(l.adopt).toEqual([{ key: 'habit:a', version: 3, body: JSON.stringify(habitBody(l.local.habits.habits[0])) }]);
  expect(l.forget).toEqual(['habit:c']);
  expect(l.notices).toEqual(['Walk: Changed on another device. Showing the saved version.', 'Calm: Deleted on another device.', 'Couldn’t sync Read. Already used, pick another']);
});

test('a pull: new rows come down, a newer server row replaces an unchanged copy, an unsent edit is never replaced, a row deleted there goes', () => {
  const a = habit('a', 'A'), b = habit('b', 'B'), c = habit('c', 'C');
  const s = local([a, b, c]);
  const sent = { 'habit:a': JSON.stringify(habitBody(a)), 'habit:b': JSON.stringify(habitBody({ ...b, name: 'older' })), 'habit:c': JSON.stringify(habitBody(c)) };
  const led = { ...EMPTY_LEDGER, v: { 'habit:a': 1, 'habit:b': 1, 'habit:c': 1 }, sent };
  const l = landPull(s, { plan: [], workout: [], habit: [row({ ...a, name: 'A2' }, 2), row({ ...b, name: 'B2' }, 2), row(habit('n', 'N'), 1)], habitLog: [] }, led, new Set(), exercises);
  expect(l.local.habits.habits.map((h) => h.name)).toEqual(['A2', 'B', 'N']); // b has an unsent edit; c was deleted on the server
  expect(l.adopt.map((x) => [x.key, x.version])).toEqual([['habit:a', 2], ['habit:n', 1]]);
  expect(l.forget).toEqual(['habit:c']);
});

test('no EXPO_PUBLIC_API_URL: doc sync stays off (nothing queued, nothing sent)', async () => {
  const fetchSpy = jest.fn();
  (global as { fetch: unknown }).fetch = fetchSpy;
  mockMem['app-state-v1'] = JSON.stringify({ user: { id: 'u', name: 'T', email: 't@x', idToken: null, mock: true }, profile: null, entries: [], steps: {}, queue: [], themePref: 'light', challenge: null, aiQuota: { used: 0 }, learned: {}, myFoods: [] });
  let st!: Store, hb!: Habits;
  const Probe = () => { st = useStore(); hb = useHabits(); return null; };
  await act(async () => { create(<StoreProvider><Probe /><DocSync /></StoreProvider>); });
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  await act(async () => { hb.create({ ...blankDraft(), name: 'Walk', short_name: 'Walk', short_name_auto: false }, '2026-10-21'); });
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  expect(st.docSyncOn).toBe(false);
  expect(st.queue).toEqual([]);
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(JSON.parse(mockMem['app-state-v1']).docs).toBeUndefined();
});
