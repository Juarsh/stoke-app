// rg10 (CEO), against a REAL backend (DELREF_URL, AUTH_MODE=dev; skipped without it): the real StoreProvider and Today.
// A DELETE the server refuses with a 4xx other than 404 (forced here: e461c87 itself only answers DELETE with 204 / 404 / 5xx)
// leaves the row on the server: the phone restores it and phone == GET /v1/entries total == /v1/summary, with the reason on
// the row. A real 404 (deleted elsewhere first) -> gone. 5xx x3 -> flagged and counted (rg9), unchanged.
// Run: DELREF_URL=http://localhost:8796 npx jest __tests__/deleteRefused.live.test.tsx
import React from 'react';
import * as http from 'http';
import { act, create } from 'react-test-renderer';

const BASE = process.env.DELREF_URL ?? '';
const mockMem: Record<string, string> = {};
jest.mock('../src/lib/kv', () => ({ kv: { get: async (k: string) => mockMem[k] ?? null, set: async (k: string, v: string) => { mockMem[k] = v; } } }));
jest.mock('expo-crypto', () => ({ randomUUID: (() => { let n = 0; return () => `dr-${n++}`; })() }));
jest.mock('../src/lib/config', () => ({ config: { apiUrl: process.env.DELREF_URL ?? '', mock: false, mockAi: false, mockAiDelay: 0, google: {} },
  flags: { steps: true, community: true, healthConnect: false, googleSignIn: false }, brand: { name: 'App', slug: 'app', scheme: 'app', androidPackage: 'x', iosBundleId: '', inviteBaseUrl: '' } }));
jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn(), push: jest.fn(), navigate: jest.fn(), replace: jest.fn() }), useLocalSearchParams: () => ({}),
  useFocusEffect: (f: () => void) => { const R = jest.requireActual('react'); R.useEffect(() => f(), []); } }));
jest.mock('react-native-safe-area-context', () => { const { View } = jest.requireActual('react-native'); return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }; });

const raw = (method: string, url: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string }> => new Promise((res, rej) => {
  const u = new URL(url);
  const q = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { ...headers, ...(body ? { 'content-length': String(Buffer.byteLength(body)) } : {}) } }, (rs) => {
    let d = ''; rs.setEncoding('utf8'); rs.on('data', (c) => (d += c)); rs.on('end', () => res({ status: rs.statusCode || 0, text: d }));
  });
  q.on('error', rej); if (body) q.write(body); q.end();
});
const forced: { id: string; status: number; body: unknown; n: number }[] = [];
(global as { fetch: unknown }).fetch = async (url: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
  const m = o.method || 'GET';
  const f = forced.find((x) => x.n > 0 && m === 'DELETE' && url.includes(`/v1/entries/${x.id}`));
  if (f) { f.n--; const t = JSON.stringify(f.body); return { ok: false, status: f.status, headers: { get: () => null }, text: async () => t, json: async () => JSON.parse(t) }; }
  const r = await raw(m, url, o.headers || {}, o.body);
  return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: () => null }, text: async () => r.text, json: async () => JSON.parse(r.text) };
};

import { StoreProvider, useStore, Store, KEPT_COPY } from '../src/lib/store';
import { counted, dayTotals, entryFromItem, dayOf, localDate, FoodEntry } from '../src/lib/domain';
import { parseLocal } from '../src/lib/parseLocal';
import { DISH_TABLE_VERSION } from '../src/parser';
import Today from '../src/features/today/TodayScreen';

const DATE = dayOf();
const tab = (id: string, t: string): FoodEntry => entryFromItem(parseLocal(t).items[0] as never, { id, slot: 'breakfast', raw_text: t, local_date: DATE, tableVersion: DISH_TABLE_VERSION });
let st!: Store; const Probe = () => { st = useStore(); return null; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const texts = (r: ReturnType<typeof create>) => r.root.findAll((n) => typeof n.type === 'string').flatMap((n) => [n.props.children].flat()).filter((c) => typeof c === 'string').join(' ');
async function settle(ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { await act(async () => { await sleep(50); }); if (st?.queue.length === 0) { await act(async () => { await sleep(200); }); if (st.queue.length === 0) return; } } }
async function totals(user: string) {
  const H = { Authorization: `Bearer dev:${user}` };
  const e = JSON.parse((await raw('GET', `${BASE}/v1/entries?date=${DATE}`, H)).text), s = JSON.parse((await raw('GET', `${BASE}/v1/summary?date=${DATE}`, H)).text);
  return { phone: dayTotals(st.entries.filter((x) => x.local_date === DATE)).kcal, server: Math.round(e.total?.kcal ?? -1), summary: Math.round(s.kcal_in ?? -1),
    ids: (e.entries as { client_id: string }[]).map((x) => x.client_id).sort() };
}
async function boot(user: string, seeded: FoodEntry[]) {
  for (const k of Object.keys(mockMem)) delete mockMem[k];
  mockMem['app-state-v1'] = JSON.stringify({ user: { id: 'u', name: 'T', email: 't@x', idToken: `dev:${user}`, mock: false }, profile: null, entries: seeded, steps: {},
    queue: seeded.map((e) => ({ kind: 'upsert', entry: e, tries: 0 })), themePref: 'light', challenge: null, aiQuota: { used: 0 }, learned: {} });
  let r!: ReturnType<typeof create>; await act(async () => { r = create(<StoreProvider><Probe /><Today /></StoreProvider>); }); await settle(); return r;
}
const run = BASE ? test : test.skip;
jest.setTimeout(120_000);

run('403 on DELETE: restored, phone == server == summary, the reason on the row; then deleted for real', async () => {
  const user = `delref-${Date.now() % 1e6}`;
  const r = await boot(user, [tab('kF', '2 roti'), tab('kG', '1 katori dal')]);
  const t0 = await totals(user); expect(t0.phone).toBe(t0.server); expect(t0.server).toBe(t0.summary);
  forced.push({ id: 'kF', status: 403, body: { error: { code: 'forbidden', message: 'This entry is locked.' } }, n: 1 });
  await act(async () => { st.deleteEntry('kF'); }); await settle();
  const t1 = await totals(user);
  expect(t1).toEqual({ ...t0 }); // unchanged on both sides: still 2 rows, same kcal
  const f = st.entries.find((x) => x.id === 'kF')!;
  expect(f.deleted_at).toBeNull(); expect(counted(f)).toBe(true); expect(f.server_note).toBe(`${KEPT_COPY} This entry is locked.`);
  expect(texts(r)).toContain('This entry is locked.');
  await act(async () => { st.deleteEntry('kF'); }); await settle(); // the server takes it now
  const t2 = await totals(user); expect(t2.phone).toBe(t2.server); expect(t2.server).toBe(t2.summary); expect(t2.ids).toEqual(['kG']);
  await act(async () => { r.unmount(); });
});
run('404 (deleted on another device first): the delete wins, phone == server == summary', async () => {
  const user = `delref404-${Date.now() % 1e6}`;
  const r = await boot(user, [tab('kF', '2 roti'), tab('kG', '1 katori dal')]);
  expect((await raw('DELETE', `${BASE}/v1/entries/kF`, { Authorization: `Bearer dev:${user}` })).status).toBe(204);
  await act(async () => { st.deleteEntry('kF'); }); await settle();
  const t = await totals(user); expect(t.phone).toBe(t.server); expect(t.server).toBe(t.summary); expect(t.ids).toEqual(['kG']);
  const f = st.entries.find((x) => x.id === 'kF')!; expect(f.deleted_at).toBeTruthy(); expect(f.server_note).toBeUndefined(); expect(f.sync_error).toBeUndefined();
  await act(async () => { r.unmount(); });
});
run('5xx x3 on DELETE: flagged and counted at the server’s numbers (rg9), unchanged', async () => {
  const user = `delref5-${Date.now() % 1e6}`;
  const r = await boot(user, [tab('kF', '2 roti'), tab('kG', '1 katori dal')]);
  forced.push({ id: 'kF', status: 500, body: { error: 'internal' }, n: 1000 });
  await act(async () => { st.deleteEntry('kF'); }); await settle(30_000);
  const f = st.entries.find((x) => x.id === 'kF')!;
  expect(f).toMatchObject({ delete_failed: true, sync_error: 'server_error' });
  const t = await totals(user); expect(t.phone).toBe(t.server); expect(t.server).toBe(t.summary); expect(t.ids).toEqual(['kF', 'kG']);
  forced.length = 0;
  await act(async () => { r.unmount(); });
});
