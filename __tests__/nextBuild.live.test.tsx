// Next build (after closed-test-2), against a REAL backend (NEXTB_URL, AUTH_MODE=dev, AI_MODE=stub; skipped without it):
// the real StoreProvider and Today. Faults are forced in front of the server (e461c87 only answers 204 / 404 / 5xx itself).
// - edge (a): an older build's row with a queued edit (no server_counts), deleted, the DELETE 5xx x3: flagged, and counted at
//   the server's copy read with GET /v1/entries/{client_id}: phone == GET /v1/entries total == /v1/summary (not 0).
// - dropped edit (CEO: always restore, never re-send): an edit still queued when the DELETE is refused (403): the row takes
//   the server's copy (qty, unit, numbers), the note says the edit wasn't saved, no edit is sent, phone == server == summary.
// Run: NEXTB_URL=http://localhost:8811 npx jest __tests__/nextBuild.live.test.tsx
import React from 'react';
import * as http from 'http';
import { act, create } from 'react-test-renderer';

const BASE = process.env.NEXTB_URL ?? '';
const mockMem: Record<string, string> = {};
jest.mock('../src/lib/kv', () => ({ kv: { get: async (k: string) => mockMem[k] ?? null, set: async (k: string, v: string) => { mockMem[k] = v; } } }));
jest.mock('expo-crypto', () => ({ randomUUID: (() => { let n = 0; return () => `nb-${n++}`; })() }));
jest.mock('../src/lib/config', () => ({ config: { apiUrl: process.env.NEXTB_URL ?? '', mock: false, mockAi: false, mockAiDelay: 0, google: {} },
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
const forced: { id: string; method: string; status: number; body: unknown; n: number }[] = [];
const log: string[] = [];
(global as { fetch: unknown }).fetch = async (url: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
  const m = o.method || 'GET';
  log.push(`${m} ${url.replace(BASE, '')}`);
  const f = forced.find((x) => x.n > 0 && m === x.method && url.includes(`/v1/entries/${x.id}`));
  if (f) { f.n--; const t = JSON.stringify(f.body); return { ok: false, status: f.status, headers: { get: () => null }, text: async () => t, json: async () => JSON.parse(t) }; }
  const r = await raw(m, url, o.headers || {}, o.body);
  return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: () => null }, text: async () => r.text, json: async () => JSON.parse(r.text) };
};

import { StoreProvider, useStore, Store, KEPT_COPY, editNotSaved } from '../src/lib/store';
import { counted, dayTotals, entryFromItem, localDate, FoodEntry } from '../src/lib/domain';
import { parseLocal } from '../src/lib/parseLocal';
import { DISH_TABLE_VERSION } from '../src/parser';
import Today from '../src/app/(tabs)/index';

const DATE = localDate();
const tab = (id: string, t: string): FoodEntry => entryFromItem(parseLocal(t).items[0] as never, { id, slot: 'breakfast', raw_text: t, local_date: DATE, tableVersion: DISH_TABLE_VERSION });
let st!: Store; const Probe = () => { st = useStore(); return null; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const texts = (r: ReturnType<typeof create>) => r.root.findAll((n) => typeof n.type === 'string').flatMap((n) => [n.props.children].flat()).filter((c) => typeof c === 'string').join(' ');
async function settle(ms = 8000, done = () => st?.queue.length === 0) { const t0 = Date.now(); while (Date.now() - t0 < ms) { await act(async () => { await sleep(50); }); if (done()) { await act(async () => { await sleep(300); }); if (done()) return; } } }
async function totals(user: string) {
  const H = { Authorization: `Bearer dev:${user}` };
  const e = JSON.parse((await raw('GET', `${BASE}/v1/entries?date=${DATE}`, H)).text), s = JSON.parse((await raw('GET', `${BASE}/v1/summary?date=${DATE}`, H)).text);
  return { phone: dayTotals(st.entries.filter((x) => x.local_date === DATE)).kcal, server: Math.round(e.total?.kcal ?? -1), summary: Math.round(s.kcal_in ?? -1),
    ids: (e.entries as { client_id: string }[]).map((x) => x.client_id).sort() };
}
async function boot(user: string, entries: FoodEntry[], queue: unknown[]) {
  for (const k of Object.keys(mockMem)) delete mockMem[k];
  mockMem['app-state-v1'] = JSON.stringify({ user: { id: 'u', name: 'T', email: 't@x', idToken: `dev:${user}`, mock: false }, profile: null, entries, steps: {},
    queue, themePref: 'light', challenge: null, aiQuota: { used: 0 }, learned: {} });
  let r!: ReturnType<typeof create>; await act(async () => { r = create(<StoreProvider><Probe /><Today /></StoreProvider>); }); await settle(); return r;
}
const saved = () => JSON.parse(mockMem['app-state-v1']) as { entries: FoodEntry[]; queue: unknown[] };
const run = BASE ? test : test.skip;
jest.setTimeout(120_000);
beforeEach(() => { forced.length = 0; log.length = 0; });

run('edge (a): older-build row with a queued edit, DELETE 5xx x3: counted at the server’s copy (GET), phone == server == summary', async () => {
  const user = `nb-a-${Date.now() % 1e6}`;
  let r = await boot(user, [tab('nO', '2 roti'), tab('nG', '1 katori dal')], [tab('nO', '2 roti'), tab('nG', '1 katori dal')].map((e) => ({ kind: 'upsert', entry: e, tries: 0 })));
  const t0 = await totals(user); expect(t0.phone).toBe(t0.server); expect(t0.server).toBe(t0.summary);
  // what an older build leaves behind: the row edited to 4 roti, the edit still queued, no server_counts
  const s0 = saved(); await act(async () => { r.unmount(); });
  const o = s0.entries.find((x) => x.id === 'nO')!; const four = tab('nO', '4 roti');
  const ed = { ...o, qty: four.qty, kcal: four.kcal, protein_g: four.protein_g, carbs_g: four.carbs_g, fat_g: four.fat_g, raw_text: '4 roti', updated_at: new Date().toISOString() } as FoodEntry;
  delete (ed as Partial<FoodEntry>).server_counts;
  forced.push({ id: 'nO', method: 'PATCH', status: 503, body: { error: 'unavailable' }, n: 1000 }, { id: 'nO', method: 'DELETE', status: 500, body: { error: 'internal' }, n: 1000 });
  r = await boot(user, s0.entries.map((x) => (x.id === 'nO' ? ed : x)), [{ kind: 'upsert', entry: ed, tries: 0 }]);
  await settle(3000, () => false);
  expect(st.entries.find((x) => x.id === 'nO')!.server_counts).toBeUndefined();
  await act(async () => { st.deleteEntry('nO'); });
  await settle(40_000, () => !!st.entries.find((x) => x.id === 'nO')?.delete_failed && !!st.entries.find((x) => x.id === 'nO')?.server_counts);
  const f = st.entries.find((x) => x.id === 'nO')!;
  expect(f).toMatchObject({ delete_failed: true, sync_error: 'server_error' }); expect(f.server_counts?.kcal).toBe(Math.round(o.kcal.best));
  expect(log).toContain('GET /v1/entries/nO');
  const t1 = await totals(user); expect(t1).toEqual(t0); // phone == server == summary, still both rows (not 0 for the flagged one)
  expect(texts(r)).toContain('(deleted)'); expect(texts(r)).not.toContain('not counted');
  forced.length = 0;
  await act(async () => { st.retrySync('nO'); }); await settle(15_000);
  const t2 = await totals(user); expect(t2.phone).toBe(t2.server); expect(t2.server).toBe(t2.summary); expect(t2.ids).toEqual(['nG']);
  await act(async () => { r.unmount(); });
});

run('dropped edit: an edit queued (PATCH 503) when the DELETE is refused 403: the server’s row comes back, no edit sent, phone == server == summary', async () => {
  const user = `nb-d-${Date.now() % 1e6}`;
  const r = await boot(user, [tab('nF', '2 roti'), tab('nG', '1 katori dal')], [tab('nF', '2 roti'), tab('nG', '1 katori dal')].map((e) => ({ kind: 'upsert', entry: e, tries: 0 })));
  const t0 = await totals(user); expect(t0.phone).toBe(t0.server); expect(t0.server).toBe(t0.summary);
  forced.push({ id: 'nF', method: 'PATCH', status: 503, body: { error: 'unavailable' }, n: 1 });
  const three = tab('nF', '3 roti'); const cur = st.entries.find((x) => x.id === 'nF')!;
  await act(async () => { st.updateEntry({ ...cur, qty: three.qty, kcal: three.kcal, protein_g: three.protein_g, carbs_g: three.carbs_g, fat_g: three.fat_g, raw_text: '3 roti' }); });
  await settle(2000, () => forced[0].n === 0);
  expect(st.queue.some((x) => x.kind === 'upsert')).toBe(true); // the edit is waiting (5xx backoff); the server would take it now
  forced.push({ id: 'nF', method: 'DELETE', status: 403, body: { error: { code: 'forbidden', message: 'This entry is locked.' } }, n: 1 });
  const n0 = log.length;
  await act(async () => { st.deleteEntry('nF'); }); await settle(8000, () => false);
  const f = st.entries.find((x) => x.id === 'nF')!;
  expect(f.deleted_at).toBeNull(); expect(counted(f)).toBe(true); expect(f.qty).toBe(cur.qty); expect(f.unit).toBe(cur.unit); expect(f.kcal.best).toBe(cur.kcal.best);
  expect(f.server_note).toBe(`${KEPT_COPY} This entry is locked. ${editNotSaved('3 pieces')}`);
  expect(log).toContain('GET /v1/entries/nF');
  expect(log.slice(n0).filter((l) => /^(PATCH|POST) \/v1\/entries/.test(l))).toEqual([]); // no edit op sent after the refusal
  expect(st.queue).toHaveLength(0);
  const t1 = await totals(user); expect(t1).toEqual(t0); // phone == server == summary, at the server's 2 roti
  expect(texts(r)).toContain(editNotSaved('3 pieces'));
  await act(async () => { r.unmount(); });
});
