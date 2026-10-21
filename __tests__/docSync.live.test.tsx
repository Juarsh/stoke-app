// M4 e2e against a REAL backend (E2E_API_URL, AUTH_MODE=dev; skipped without it): the real StoreProvider, plans, workouts,
// habits and DocSync, through api.ts and the offline queue.
//  1. made offline (a plan, a workout, a habit and today's log), synced when the connection is back: phone == server ==
//     the server's workout summary
//  2. a second device saved first: the phone's stale edit gets 409, the server's row stays and the phone shows it + why
//  3. the server refuses (400, a short name another device already took): the phone keeps its value and shows the reason
// Run: E2E_API_URL=http://localhost:8095 npx jest __tests__/docSync.live.test.tsx
import React from 'react';
import * as http from 'http';
import { act, create } from 'react-test-renderer';

const BASE = process.env.E2E_API_URL ?? '';
const mockMem: Record<string, string> = {};
jest.mock('../src/lib/kv', () => ({ kv: { get: async (k: string) => mockMem[k] ?? null, set: async (k: string, v: string) => { mockMem[k] = v; } } }));
jest.mock('expo-crypto', () => ({ randomUUID: (() => { let n = 0; const run = Date.now().toString(36); return () => `e2e-${run}-${n++}`; })() }));
jest.mock('../src/lib/config', () => ({ config: { apiUrl: process.env.E2E_API_URL ?? '', mock: false, mockAi: false, mockAiDelay: 0, google: {} },
  flags: { steps: true, community: true, healthConnect: false, googleSignIn: false }, brand: { name: 'App', slug: 'app', scheme: 'app', androidPackage: 'x', iosBundleId: '', inviteBaseUrl: '' } }));

const raw = (method: string, url: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string }> => new Promise((res, rej) => {
  const u = new URL(url);
  const q = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { ...headers, 'content-type': 'application/json', ...(body ? { 'content-length': String(Buffer.byteLength(body)) } : {}) } }, (rs) => {
    let d = ''; rs.setEncoding('utf8'); rs.on('data', (c) => (d += c)); rs.on('end', () => res({ status: rs.statusCode || 0, text: d }));
  });
  q.on('error', rej); if (body) q.write(body); q.end();
});
let offline = false;
const seen: string[] = [];
(global as { fetch: unknown }).fetch = async (url: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
  if (offline) throw new TypeError('Network request failed');
  const r = await raw(o.method || 'GET', url, o.headers || {}, o.body);
  seen.push(`${o.method || 'GET'} ${url.replace(BASE, '')} ${r.status}`);
  return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: () => null }, text: async () => r.text, json: async () => JSON.parse(r.text) };
};

import { StoreProvider, useStore, Store } from '../src/lib/store';
import { DocSync } from '../src/lib/DocSync';
import { usePlans, Plans } from '../src/lib/plans';
import { useWorkouts, Workouts } from '../src/lib/workouts';
import { useHabits, Habits } from '../src/lib/habits';
import { exercises } from '../src/lib/exercises';
import { dayOf } from '../src/lib/domain';
import { kindOf, stats } from '../src/features/workout/model';
import { blankDraft, draftOf } from '../src/features/habits/model';

const TODAY = dayOf();
const USER = `e2e${Date.now().toString(36)}`;
const H = { Authorization: `Bearer dev:${USER}` };
const get = async (path: string) => { const r = await raw('GET', BASE + path, H); return { status: r.status, body: r.text ? JSON.parse(r.text) : null }; };
const put = async (path: string, body: unknown) => { const r = await raw('PUT', BASE + path, H, JSON.stringify(body)); return { status: r.status, body: JSON.parse(r.text) }; };

let st!: Store, pl!: Plans, wo!: Workouts, hb!: Habits;
const Probe = () => { st = useStore(); pl = usePlans(); wo = useWorkouts(); hb = useHabits(); return null; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const docOps = () => st.queue.filter((o) => o.kind === 'doc');
async function settle(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { await act(async () => { await sleep(100); }); if (!offline && docOps().length === 0) { await act(async () => { await sleep(300); }); if (docOps().length === 0) return; } }
  throw new Error(`queue did not drain: ${JSON.stringify(docOps().map((o) => [o.id, o.tries]))}`);
}
const run = BASE ? test : test.skip;
jest.setTimeout(90_000);

beforeAll(async () => {
  for (const k of Object.keys(mockMem)) delete mockMem[k];
  mockMem['app-state-v1'] = JSON.stringify({ user: { id: USER, name: 'T', email: 't@x', idToken: `dev:${USER}`, mock: false }, profile: null, entries: [], steps: {},
    queue: [], themePref: 'light', challenge: null, aiQuota: { used: 0 }, learned: {}, myFoods: [] });
});

run('1. made offline, synced later: phone == server == summary', async () => {
  offline = true;
  await act(async () => { create(<StoreProvider><Probe /><DocSync /></StoreProvider>); });
  await act(async () => { await sleep(300); });
  expect(st.docSyncOn).toBe(true);
  // offline: a plan, a workout (weight + bodyweight sets), a habit and today's log
  let planId = '';
  await act(async () => { planId = pl.applyTemplate('ppl').id; });
  const weight = exercises.all().find((e) => kindOf(e) === 'weight')!, body = exercises.all().find((e) => kindOf(e) === 'bodyweight')!;
  await act(async () => { wo.startEmpty(); });
  await act(async () => { wo.addExercise(weight.id); wo.addExercise(body.id); });
  const [xw, xb] = wo.active!.exercises;
  const ticks: [string, string, string, string][] = [[xw.id, xw.sets[0].id, '62.5', '10'], [xw.id, xw.sets[1].id, '62.5', '8'], [xb.id, xb.sets[0].id, '', '12'], [xb.id, xb.sets[1].id, '10', '6']];
  for (const [e, s, kg, reps] of ticks) {
    await act(async () => { wo.setInput(e, s, 'kg_in', kg); wo.setInput(e, s, 'reps_in', reps); });
    await act(async () => { expect(wo.tick(e, s)).toBeNull(); });
  }
  let done: unknown;
  await act(async () => { done = wo.finish(); });
  const session = done as Exclude<ReturnType<Workouts['finish']>, string>;
  expect(typeof session).toBe('object');
  let habitId = '';
  await act(async () => { const h = hb.create({ ...blankDraft(), name: 'Drink water', short_name: 'Water', short_name_auto: false, kind: 'count', target_value: 8, unit: 'glasses' }, TODAY); habitId = (h as { id: string }).id; });
  await act(async () => { expect(hb.setAmount(habitId, TODAY, 3, TODAY)).toBeNull(); });
  await act(async () => { await sleep(300); });
  expect(docOps().map((o) => o.id).sort()).toEqual([`habit:${habitId}`, `habitLog:${habitId}/${TODAY}`, `plan:${planId}`, `workout:${session.id}`].sort());

  // back online: the queue drains (its backoff timer fires)
  offline = false;
  await settle();
  const w = await get(`/v1/workouts/${session.id}`);
  expect(w.status).toBe(200);
  const phone = stats(wo.state.sessions.find((s) => s.id === session.id)!, exercises);
  // phone == server == summary: 62.5×10 + 62.5×8 + 10×6 (bodyweight: added kg only) = 1185
  expect(phone.volume).toBe(1185);
  expect({ volume: w.body.summary.volume_kg, done: w.body.summary.sets_done, reps: w.body.summary.reps }).toEqual({ volume: phone.volume, done: phone.done, reps: phone.reps });
  expect(w.body.exercises.map((x: { sets: { kg: number | null; reps: number }[] }) => x.sets.map((y) => [y.kg, y.reps]))).toEqual([[[62.5, 10], [62.5, 8]], [[null, 12], [10, 6]]]);
  const p = await get(`/v1/plans/${planId}`);
  expect({ name: p.body.name, days: p.body.days, active: p.body.active, routines: p.body.routines.length })
    .toEqual({ name: pl.state.plans[0].name, days: pl.state.plans[0].days.map((d) => d ?? ''), active: true, routines: pl.state.plans[0].routines.length });
  const logs = await get(`/v1/habit-logs?from=${TODAY}&to=${TODAY}`);
  expect(logs.body.logs.map((l: { habit_id: string; value: number; done: boolean }) => [l.habit_id, l.value, l.done])).toEqual([[habitId, 3, false]]);
  // the phone knows each row's server version now
  expect(st.docLedger().v[`habit:${habitId}`]).toBe(1);
});

run('2. a second device saved first: the server row stays, the phone shows it and why', async () => {
  const h = hb.state.habits[0];
  // device B renames it on version 1
  const b = await put(`/v1/habits/${h.id}`, { name: 'Water (B)', short_name: 'H2O', short_name_auto: false, icon: h.icon, kind: h.kind, target_value: h.target_value, unit: h.unit,
    target_sets: null, target_reps: null, schedule: h.schedule, weekdays: h.weekdays, starts_on: h.starts_on, position: h.position, archived_at: null, version: 1 });
  expect([b.status, b.body.version]).toEqual([200, 2]);
  // the phone edits the same habit (it still knows version 1)
  await act(async () => { expect(hb.update(h.id, { ...draftOf(h), name: 'Water (phone)' })).toBeNull(); });
  await settle();
  expect(seen.some((x) => x.startsWith(`PUT /v1/habits/${h.id} 409`))).toBe(true);
  const now = hb.state.habits.find((x) => x.id === h.id)!;
  expect([now.name, now.short_name]).toEqual(['Water (B)', 'H2O']); // the server's row, on the phone
  expect((await get(`/v1/habits/${h.id}`)).body.name).toBe('Water (B)'); // never overwritten
  expect(st.notice).toBe('Water: Changed on another device. Showing the saved version.'); // named as the phone knew it
  expect(st.docLedger().v[`habit:${h.id}`]).toBe(2);
  // nothing left to send (the phone's copy is the server's)
  await act(async () => { await sleep(500); });
  expect(docOps()).toEqual([]);
  await act(async () => { st.dismissNotice(); });
});

run('3. a refusal (400): the phone keeps its value and shows the reason', async () => {
  // device B takes the short name "Read"
  const b = await put('/v1/habits/b-read', { name: 'Read a book', short_name: 'Read', short_name_auto: true, icon: null, kind: 'done', target_value: null, unit: null,
    target_sets: null, target_reps: null, schedule: 'daily', weekdays: 127, starts_on: TODAY, position: 5, archived_at: null });
  expect(b.status).toBe(200);
  let id = '';
  await act(async () => { const h = hb.create({ ...blankDraft(), name: 'Read 10 pages', short_name: 'Read', short_name_auto: false }, TODAY); id = (h as { id: string }).id; });
  await settle();
  expect(seen.some((x) => x.startsWith(`PUT /v1/habits/${id} 400`))).toBe(true);
  const mine = hb.state.habits.find((x) => x.id === id);
  expect([mine?.name, mine?.short_name]).toEqual(['Read 10 pages', 'Read']); // kept on the phone
  expect(st.notice).toBe('Couldn’t sync Read. Already used, pick another');
  expect((await get(`/v1/habits/${id}`)).status).toBe(404);
  // phone == server for everything else: the server's habits are the phone's minus the refused one plus B's
  const server = (await get('/v1/habits')).body.habits.map((x: { id: string }) => x.id).sort();
  expect(server).toEqual([...hb.state.habits.filter((x) => x.id !== id).map((x) => x.id), 'b-read'].sort());
});
