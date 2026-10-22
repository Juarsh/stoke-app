// Item 16, the real store: a local-only user's data (food entries in the queue, a habit) goes up on the first Google
// sign-in, with our session as the bearer, and nothing local is lost; a 401 later signs out with a message and keeps every
// entry and queued change; an app start whose keystore lost the session signs out the same way.
import React from 'react';
import { act, create } from 'react-test-renderer';

jest.mock('../src/lib/config', () => ({ config: { apiUrl: 'http://api.test', mock: false, mockAi: false, mockAiDelay: 0, google: { web: 'web.apps.googleusercontent.com' } },
  flags: { steps: true, community: true, healthConnect: false, googleSignIn: true }, brand: { name: 'Stoke' } }));
const mockMem: Record<string, string> = {};
jest.mock('../src/lib/kv', () => ({ kv: { get: async (k: string) => mockMem[k] ?? null, set: async (k: string, v: string) => { mockMem[k] = v; } } }));
const mockKeys: Record<string, string> = {};
jest.mock('expo-secure-store', () => ({
  getItemAsync: async (k: string) => mockKeys[k] ?? null, setItemAsync: async (k: string, v: string) => { mockKeys[k] = v; }, deleteItemAsync: async (k: string) => { delete mockKeys[k]; },
}));
let mockN = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `id${++mockN}` }));

import { LOCAL_USER, StoreProvider, Store, useStore } from '../src/lib/store';
import { DocSync } from '../src/lib/DocSync';
import { useHabits, Habits } from '../src/lib/habits';
import { blankDraft } from '../src/features/habits/model';
import { entryFromItem, dayOf, type FoodEntry } from '../src/lib/domain';
import { parseLocal } from '../src/lib/api';
import { DISH_TABLE_VERSION } from '../src/parser';

const DAY = dayOf();
const entry = (id: string, t: string): FoodEntry => entryFromItem(parseLocal(t).items[0] as never, { id, slot: 'lunch', raw_text: t, local_date: DAY, tableVersion: DISH_TABLE_VERSION });
type Call = { method: string; path: string; auth: string | undefined; body?: unknown };
let calls: Call[] = [];
let refuse401 = (_c: Call) => false;
const json = (status: number, b: unknown) => ({ ok: status < 300, status, headers: { get: () => null }, json: async () => b, text: async () => JSON.stringify(b) });
(global as { fetch: unknown }).fetch = jest.fn(async (url: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
  const c: Call = { method: o.method ?? 'GET', path: url.replace('http://api.test', ''), auth: o.headers?.Authorization, body: o.body ? JSON.parse(o.body) : undefined };
  calls.push(c);
  if (refuse401(c)) return json(401, { error: 'session expired or signed out' });
  if (c.method === 'POST' && c.path === '/v1/entries') return json(201, { entries: [{ version: 1, state: 'confirmed' }] });
  if (c.method === 'PUT' && c.path.startsWith('/v1/habits/')) return json(200, { ...(c.body as object), id: decodeURIComponent(c.path.split('/')[3]), version: 1, created_at: 'c', updated_at: 'u' });
  const lists: Record<string, unknown> = { '/v1/plans': { plans: [] }, '/v1/workouts': { workouts: [] }, '/v1/habits': { habits: [] }, '/v1/habit-logs': { logs: [] }, '/v1/remembered': { remembered: [] } };
  return json(200, lists[c.path] ?? {});
});

let st!: Store, hb!: Habits;
const Probe = () => { st = useStore(); hb = useHabits(); return null; };
const settle = async (ms = 400) => { for (let i = 0; i < ms / 20; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };
const boot = async () => { await act(async () => { create(<StoreProvider><Probe /><DocSync /></StoreProvider>); }); await settle(100); };
const reset = (persisted: object | null, key?: string) => {
  for (const k of Object.keys(mockMem)) delete mockMem[k];
  for (const k of Object.keys(mockKeys)) delete mockKeys[k];
  if (persisted) mockMem['app-state-v1'] = JSON.stringify({ profile: null, entries: [], steps: {}, queue: [], themePref: 'light', challenge: null, aiQuota: { used: 0 }, learned: {}, myFoods: [], ...persisted });
  if (key) mockKeys['stoke.session.v1'] = key;
  calls = []; refuse401 = () => false;
};

test('local-only: nothing is sent; the first sign-in uploads every entry and habit with the session, nothing is lost', async () => {
  reset({ user: LOCAL_USER });
  await boot();
  expect(st.api.mock).toBe(true);
  await act(async () => { st.addEntries([entry('e1', '2 roti'), entry('e2', '1 bowl dal')]); });
  await act(async () => { hb.create({ ...blankDraft(), name: 'Walk', short_name: 'Walk', short_name_auto: false }, DAY); });
  await settle();
  expect(calls).toEqual([]);
  expect(st.queue.filter((o) => o.kind === 'upsert')).toHaveLength(2);
  expect(st.docSyncOn).toBe(false);

  // Google sign-in done (googleSignIn saved the session in the keystore); the store takes it from here
  mockKeys['stoke.session.v1'] = 'stk_abc';
  await act(async () => { st.signInSession({ id: '42', name: 'Akarsh', email: 'akarsh@gmail.com', token: 'stk_abc' }); });
  await settle(1500);
  expect(st.signedInGoogle).toBe(true);
  expect(st.api.mock).toBe(false);
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every((c) => c.auth === 'Bearer stk_abc')).toBe(true);
  const posted = calls.filter((c) => c.method === 'POST' && c.path === '/v1/entries').map((c) => (c.body as { items: { client_id: string }[] }).items[0].client_id);
  expect(posted.sort()).toEqual(['e1', 'e2']);
  const habitId = hb.state.habits[0].id;
  expect(calls.some((c) => c.method === 'PUT' && c.path === `/v1/habits/${habitId}`)).toBe(true);
  expect(calls.findIndex((c) => c.path === '/v1/habits' && c.method === 'GET')).toBeLessThan(calls.findIndex((c) => c.method === 'PUT' && c.path.startsWith('/v1/habits/'))); // pull first
  expect(st.queue).toEqual([]);
  expect(st.entries.map((e) => [e.id, e.server_version])).toEqual([['e1', 1], ['e2', 1]]);
  expect(hb.state.habits.map((h) => h.name)).toEqual(['Walk']);
  expect(st.docLedger().uid).toBe('42');
  // the session is in the keystore only, never in the app's state file
  expect(mockMem['app-state-v1']).not.toContain('stk_abc');

  // later the server says 401 (the session ended): signed out with a message; every entry and queued change stays
  refuse401 = (c) => c.method === 'POST' && c.path === '/v1/entries';
  await act(async () => { st.addEntries([entry('e3', '1 apple')]); });
  await settle(600);
  expect(st.user).toBeNull();
  expect(st.notice).toMatch(/^You were signed out \(session expired or signed out\)\. Everything is still on this phone/);
  expect(st.entries.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
  expect(st.queue.some((o) => o.kind === 'upsert' && o.entry.id === 'e3')).toBe(true);
  expect(mockKeys).toEqual({});
  expect(hb.state.habits).toHaveLength(1);
});

test('app start: a Google user whose keystore has no session is signed out with the message; data kept', async () => {
  reset({ user: { id: '42', name: 'A', email: 'a@x', idToken: null, mock: false }, entries: [entry('k1', '2 roti')] });
  await boot();
  expect(st.user).toBeNull();
  expect(st.notice).toMatch(/^You were signed out\. Everything is still on this phone/);
  expect(st.entries.map((e) => e.id)).toEqual(['k1']);
  expect(calls).toEqual([]);
});

test('app start with the session in the keystore: still signed in, the session is the bearer', async () => {
  reset({ user: { id: '42', name: 'A', email: 'a@x', idToken: null, mock: false } }, 'stk_kept');
  await boot();
  await settle(300);
  expect(st.signedInGoogle).toBe(true);
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every((c) => c.auth === 'Bearer stk_kept')).toBe(true);
  // sign out: revoked on the server, gone from the keystore, data kept
  calls = [];
  await act(async () => { st.signOut(); });
  await settle(100);
  expect(calls).toEqual([{ method: 'POST', path: '/v1/auth/signout', auth: 'Bearer stk_kept', body: undefined }]);
  expect(mockKeys).toEqual({});
  expect(st.user).toBeNull();
});
