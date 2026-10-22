// Item 16 e2e against a REAL backend (E2E_API_URL, AUTH_MODE=dev; skipped without it): a local-only phone with food and a
// habit signs in (POST /v1/auth/google with a dev token stands in for Google's ID token), everything goes up with the
// session as the bearer, the server has it all, and sign-out revokes the session (401 after).
// Run: E2E_API_URL=http://localhost:8097 npx jest __tests__/signIn.live.test.tsx
import React from 'react';
import * as http from 'http';
import { act, create } from 'react-test-renderer';

const BASE = process.env.E2E_API_URL ?? '';
jest.mock('../src/lib/config', () => ({ config: { apiUrl: process.env.E2E_API_URL ?? '', mock: false, mockAi: false, mockAiDelay: 0, google: { web: 'w' } },
  flags: { steps: true, community: true, healthConnect: false, googleSignIn: true }, brand: { name: 'Stoke' } }));
const mockMem: Record<string, string> = {};
jest.mock('../src/lib/kv', () => ({ kv: { get: async (k: string) => mockMem[k] ?? null, set: async (k: string, v: string) => { mockMem[k] = v; } } }));
const mockKeys: Record<string, string> = {};
jest.mock('expo-secure-store', () => ({ getItemAsync: async (k: string) => mockKeys[k] ?? null, setItemAsync: async (k: string, v: string) => { mockKeys[k] = v; }, deleteItemAsync: async (k: string) => { delete mockKeys[k]; } }));
jest.mock('expo-crypto', () => ({ randomUUID: (() => { let n = 0; const run = Date.now().toString(36); return () => `si-${run}-${n++}`; })() }));

const raw = (method: string, url: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string }> => new Promise((res, rej) => {
  const u = new URL(url);
  const q = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { ...headers, 'content-type': 'application/json', ...(body ? { 'content-length': String(Buffer.byteLength(body)) } : {}) } }, (rs) => {
    let d = ''; rs.setEncoding('utf8'); rs.on('data', (c) => (d += c)); rs.on('end', () => res({ status: rs.statusCode || 0, text: d }));
  });
  q.on('error', rej); if (body) q.write(body); q.end();
});
const auths = new Set<string>();
(global as { fetch: unknown }).fetch = async (url: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
  if (o.headers?.Authorization) auths.add(o.headers.Authorization.slice(0, 11));
  const r = await raw(o.method || 'GET', url, o.headers || {}, o.body);
  return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: () => null }, text: async () => r.text, json: async () => JSON.parse(r.text) };
};

import { LOCAL_USER, StoreProvider, Store, useStore } from '../src/lib/store';
import { DocSync } from '../src/lib/DocSync';
import { useHabits, Habits } from '../src/lib/habits';
import { blankDraft } from '../src/features/habits/model';
import { entryFromItem, dayOf } from '../src/lib/domain';
import { parseLocal } from '../src/lib/api';
import { DISH_TABLE_VERSION } from '../src/parser';

const DAY = dayOf();
const run = BASE ? test : test.skip;
jest.setTimeout(60_000);
let st!: Store, hb!: Habits;
const Probe = () => { st = useStore(); hb = useHabits(); return null; };
const settle = async (ms: number) => { for (let i = 0; i < ms / 50; i++) await act(async () => { await new Promise((r) => setTimeout(r, 50)); }); };

run('local-only data goes up on the first sign-in, with our session; sign-out revokes it', async () => {
  mockMem['app-state-v1'] = JSON.stringify({ user: LOCAL_USER, profile: null, entries: [], steps: {}, queue: [], themePref: 'light', challenge: null, aiQuota: { used: 0 }, learned: {}, myFoods: [] });
  await act(async () => { create(<StoreProvider><Probe /><DocSync /></StoreProvider>); });
  await settle(200);
  const t = '2 roti';
  const e = entryFromItem(parseLocal(t).items[0] as never, { id: `si-food-${Date.now().toString(36)}`, slot: 'lunch', raw_text: t, local_date: DAY, tableVersion: DISH_TABLE_VERSION });
  await act(async () => { st.addEntries([e]); });
  await act(async () => { hb.create({ ...blankDraft(), name: 'Stretch', short_name: 'Stretch', short_name_auto: false }, DAY); });
  await settle(200);
  expect(auths.size).toBe(0); // local-only: nothing sent

  const who = `si${Date.now().toString(36)}`;
  const a = await st.api.signInGoogle(`dev:${who}`);
  expect(a.session_token).toMatch(/^stk_/);
  mockKeys['stoke.session.v1'] = a.session_token;
  await act(async () => { st.signInSession({ id: String(a.user.id), name: '', email: a.user.email ?? '', token: a.session_token }); });
  for (let i = 0; i < 100 && st.queue.length; i++) await settle(100);
  expect(st.queue).toEqual([]);
  expect([...auths]).toEqual(['Bearer stk_']);

  const H = { Authorization: `Bearer ${a.session_token}` };
  const entries = JSON.parse((await raw('GET', `${BASE}/v1/entries?date=${DAY}`, H)).text);
  expect(JSON.stringify(entries)).toContain(e.id);
  const habits = JSON.parse((await raw('GET', `${BASE}/v1/habits`, H)).text).habits as { id: string; name: string }[];
  expect(habits.map((h) => [h.id, h.name])).toEqual([[hb.state.habits[0].id, 'Stretch']]);
  // the dev token's own identity is the same server user as the session
  const viaDev = JSON.parse((await raw('GET', `${BASE}/v1/habits`, { Authorization: `Bearer dev:${who}` })).text).habits;
  expect(viaDev).toHaveLength(1);

  await act(async () => { st.signOut(); });
  await settle(300);
  expect((await raw('GET', `${BASE}/v1/habits`, H)).status).toBe(401);
  expect(st.entries.map((x) => x.id)).toEqual([e.id]);
  expect(hb.state.habits).toHaveLength(1);
});
