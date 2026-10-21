// next build (rg10 T2): a row flagged after 3x 5xx retries by itself once the server is back: on a backoff (30 s doubling,
// max 30 min; app start counts as foreground, so its next one is 60 s), when the app comes to the foreground, and right after
// any request that succeeds. It stays flagged and counted as the server has it until a retry succeeds; then the flag clears
// and phone == server. One 5xx flags it again at once. Tap-retry still works.
import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { AppState } from 'react-native';

jest.mock('../src/lib/config', () => ({ config: { mock: false, apiUrl: 'http://api.test', mockAi: false }, flags: {} }));
let mockSaved: string | null = null;
jest.mock('../src/lib/kv', () => ({ kv: { get: async () => mockSaved, set: async (_k: string, v: string) => { mockSaved = v; } } }));
let mockN = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `id${++mockN}` }));

import { StoreProvider, Store, useStore, queueAutoRetry, autoRetryMs, autoRetryable, anyOk, applyFlush, AUTO_RETRY_FIRST_MS } from '../src/lib/store';
import { counted, dayTotals, entryFromItem, FoodEntry, dayOf, localDate } from '../src/lib/domain';
import { parser, DISH_TABLE_VERSION, Item } from '../src/parser';
import { flush, MAX_FIVES, NOT_DELETED_REASON, Op, SERVER_ERROR } from '../src/lib/syncQueue';
import { ApiError } from '../src/lib/api';

const DAY = dayOf();
const tableEntry = (id: string, dish: string, qty: number, unit: string, extra: Partial<FoodEntry> = {}): FoodEntry => {
  const it = { ...parser.recompute(dish, qty, unit, ''), needs_confirmation: false } as Item;
  return { ...entryFromItem(it, { id, slot: 'lunch', raw_text: `${qty} ${unit} ${dish}`, local_date: DAY, tableVersion: DISH_TABLE_VERSION }), qty, unit, ...extra };
};
const server = { rows: new Map<string, { kcal: number; protein: number; qty: number; unit: string; version: number }>(), fail: false, log: [] as string[],
  reset() { this.rows.clear(); this.fail = false; this.log = []; } };
const reply = (status: number, body: unknown = {}) => ({ ok: status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
const out = (r: { kcal: number; protein: number; qty: number; unit: string; version: number }) => ({ version: r.version, state: 'confirmed', qty: r.qty, unit: r.unit, kcal_best: r.kcal, protein_best: r.protein });
async function fakeFetch(url: string, init: { method: string; body?: string }) {
  const path = url.replace('http://api.test', ''); const b = init.body ? JSON.parse(init.body) : {};
  if (path === '/v1/remembered') return reply(200, { remembered: [] });
  if (path === '/v1/dishes') return reply(200, []);
  server.log.push(`${init.method} ${path}${init.method === 'POST' && b.items?.[0] ? ` ${b.items[0].client_id}` : ''}`);
  if (server.fail && path.startsWith('/v1/entries')) return reply(503, { error: 'unavailable' });
  if (init.method === 'POST' && path === '/v1/entries') {
    const it = b.items[0]; const had = server.rows.get(it.client_id);
    if (had) return reply(200, { duplicates: [it.client_id], entries: [out(had)] });
    const r = { kcal: Number(it.kcal ?? 0), protein: Number(it.protein_g ?? 0), qty: it.qty, unit: it.unit, version: 1 };
    server.rows.set(it.client_id, r); return reply(201, { entries: [out(r)] });
  }
  const id = decodeURIComponent((/^\/v1\/entries\/(.+)$/.exec(path) ?? [])[1] ?? ''); const r = server.rows.get(id);
  if (!r) return reply(404, { error: 'entry not found' });
  if (init.method === 'GET') return reply(200, out(r));
  if (init.method === 'DELETE') { server.rows.delete(id); return reply(204); }
  Object.assign(r, { kcal: Number(b.kcal ?? r.kcal), protein: Number(b.protein_g ?? r.protein), qty: b.qty ?? r.qty, unit: b.unit ?? r.unit, version: r.version + 1 });
  return reply(200, out(r));
}
const serverTotal = () => Math.round([...server.rows.values()].reduce((a, x) => a + x.kcal, 0));
let st!: Store;
function Probe() { st = useStore(); return null; }
let r!: ReactTestRenderer;
let now = Date.parse('2026-10-17T06:00:00Z');
const flushP = async (n = 30) => { for (let i = 0; i < n; i++) await act(async () => { await Promise.resolve(); }); };
/** move the clock (Date.now and timers) forward and let the store settle */
const advance = async (ms: number) => {
  const step = 1000;
  for (let t = 0; t < ms; t += step) { const d = Math.min(step, ms - t); now += d; await act(async () => { jest.advanceTimersByTime(d); }); await flushP(4); }
  await flushP();
};
/** save / delete attempts (a save to a row the server has is POST -> duplicate -> PATCH: one attempt) */
const writes = () => server.log.filter((l) => /^(POST|DELETE) \/v1\/entries/.test(l));
let appListeners: ((s: string) => void)[] = [];
async function boot(entries: FoodEntry[], queue: Op[] = []) {
  mockN = 0;
  mockSaved = JSON.stringify({ user: { id: 'u', name: 'A', email: 'a@x', idToken: 't', mock: false }, entries, queue, aiQuota: { used: 0 } });
  await act(async () => { r = create(<StoreProvider><Probe /></StoreProvider>); });
  await flushP(60);
}
beforeAll(() => { (global as unknown as { fetch: unknown }).fetch = jest.fn(fakeFetch); });
beforeEach(() => {
  server.reset(); appListeners = [];
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_: string, f: (s: string) => void) => { appListeners.push(f); return { remove: () => { appListeners = appListeners.filter((x) => x !== f); } }; }) as never);
});
afterEach(async () => { await act(async () => { r?.unmount(); }); jest.restoreAllMocks(); jest.useRealTimers(); });

/** a synced 2-roti row (server 220) edited to 3 roti (330) on the phone, flagged after 3x 5xx: counted at the server's 220 */
const flaggedEdit = () => ({ ...tableEntry('F', 'roti', 3, 'count'), server_version: 1, server_counts: { kcal: 220, protein: 7 }, server_failed: true, sync_error: SERVER_ERROR });
const seed220 = () => server.rows.set('F', { kcal: 220, protein: 7, qty: 2, unit: 'count', version: 1 });
const F = () => st.entries.find((e) => e.id === 'F')!;

describe('pure', () => {
  test('schedule: 30 s, doubling, max 30 min', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 20].map(autoRetryMs)).toEqual([30e3, 60e3, 120e3, 240e3, 480e3, 960e3, 1800e3, 1800e3, 1800e3]);
    expect(AUTO_RETRY_FIRST_MS).toBe(30_000);
  });
  test('queueAutoRetry: only 5xx-flagged rows with nothing queued and no tap spinner; an edit re-sends the row, a delete the delete; one 5xx re-flags', () => {
    const e = flaggedEdit();
    const d = { ...tableEntry('D', 'dal', 1, 'katori'), server_version: 1, deleted_at: 'x', delete_failed: true, server_failed: true, sync_error: SERVER_ERROR, sync_reason: NOT_DELETED_REASON, unsynced_edit: true };
    const other = { ...tableEntry('O', 'dal', 1, 'katori'), sync_error: 'http_403' };
    const spin = { ...flaggedEdit(), id: 'S', sync_retrying: true };
    const p = queueAutoRetry({ entries: [e, d, other, spin], queue: [] as Op[] });
    expect(p.queue).toEqual([{ kind: 'upsert', entry: e, tries: 0, fives: MAX_FIVES - 1, auto: true }, { kind: 'delete', id: 'D', tries: 0, fives: MAX_FIVES - 1, auto: true, edited: true }]);
    expect(p.entries).toEqual([e, d, other, spin]); // still flagged (and counted as the server has it) until it succeeds
    expect(autoRetryable(e, p.queue)).toBe(false);
    expect(queueAutoRetry(p)).toBe(p); // nothing twice
    expect(queueAutoRetry({ entries: [e, d], queue: [] as Op[] }, ['D']).queue.map((o) => o.kind)).toEqual(['delete']);
  });
  test('one 5xx on the retry flags it again at once; a success clears the flag and counts the server’s row', async () => {
    const e = flaggedEdit();
    const q = queueAutoRetry({ entries: [e], queue: [] as Op[] }).queue;
    const bad = await flush(q, { upsertEntry: async () => { throw new ApiError(503, 'x'); }, deleteEntry: async () => {}, resolvePending: async () => null, deleteRemembered: async () => {} }, now);
    expect(bad.failed).toEqual([{ id: 'F', code: SERVER_ERROR, sent: e }]); expect(bad.rest).toEqual([]);
    expect(anyOk(q, bad)).toBe(false);
    const again = applyFlush({ entries: [e], queue: q }, q, bad);
    expect(again.entries[0]).toMatchObject({ sync_error: SERVER_ERROR, server_failed: true, server_counts: { kcal: 220, protein: 7 } });
    expect(dayTotals(again.entries).kcal).toBe(220);
    const row = { version: 2, state: 'confirmed', qty: 3, unit: 'count', kcal_best: e.kcal.best, protein_best: e.protein_g.best };
    const ok = await flush(q, { upsertEntry: async () => ({ version: 2, row }), deleteEntry: async () => {}, resolvePending: async () => null, deleteRemembered: async () => {} }, now);
    expect(anyOk(q, ok)).toBe(true);
    const done = applyFlush({ entries: [e], queue: q }, q, ok).entries[0];
    expect(done.sync_error).toBeUndefined(); expect(done.server_failed).toBeUndefined(); expect(done.server_counts).toEqual({ kcal: e.kcal.best, protein: e.protein_g.best });
    expect(dayTotals([done]).kcal).toBe(Math.round(e.kcal.best));
  });
});

describe('store', () => {
  test('backoff: app start tries once; while the server is down it retries at 60 s, then 120 s; when it is back the flag clears and phone == server', async () => {
    seed220(); server.fail = true;
    await boot([flaggedEdit()]);
    expect(writes()).toEqual(['POST /v1/entries F']); // app start
    expect(F()).toMatchObject({ sync_error: SERVER_ERROR, server_failed: true }); expect(dayTotals(st.entries).kcal).toBe(220);
    await advance(58_000); expect(writes()).toHaveLength(1);
    await advance(4_000); expect(writes()).toHaveLength(2);
    expect(F().sync_error).toBe(SERVER_ERROR); expect(st.queue).toHaveLength(0);
    await advance(115_000); expect(writes()).toHaveLength(2);
    server.fail = false;
    await advance(8_000); expect(writes()).toHaveLength(3);
    expect(F().sync_error).toBeUndefined(); expect(F().server_failed).toBeUndefined();
    expect(server.rows.get('F')).toMatchObject({ qty: 3, kcal: F().kcal.best });
    expect(dayTotals(st.entries).kcal).toBe(serverTotal()); expect(serverTotal()).toBe(Math.round(F().kcal.best));
    await advance(30 * 60_000); expect(writes()).toHaveLength(3); // nothing left to retry
  });
  test('a row flagged while the app runs is first retried 30 s later', async () => {
    seed220();
    await boot([{ ...tableEntry('F', 'roti', 2, 'count'), server_version: 1, server_counts: { kcal: 220, protein: 7 } }]);
    server.fail = true;
    await act(async () => { st.updateEntry({ ...tableEntry('F', 'roti', 3, 'count'), server_version: 1, server_counts: { kcal: 220, protein: 7 } }); });
    for (let i = 0; i < 60 && !F().sync_error; i++) await advance(1000); // 5xx, 5 s, 5xx, 10 s, 5xx -> flagged
    expect(F().sync_error).toBe(SERVER_ERROR);
    const n = writes().length; server.fail = false;
    await advance(25_000); expect(writes()).toHaveLength(n);
    await advance(10_000); expect(writes()).toHaveLength(n + 1);
    expect(F().sync_error).toBeUndefined(); expect(dayTotals(st.entries).kcal).toBe(serverTotal());
  });
  test('foreground: coming back to the app retries now', async () => {
    seed220(); server.fail = true;
    await boot([flaggedEdit()]);
    server.fail = false;
    await advance(1_000); expect(writes()).toHaveLength(1);
    await act(async () => { appListeners.forEach((f) => f('background')); }); await flushP();
    expect(writes()).toHaveLength(1);
    await act(async () => { appListeners.forEach((f) => f('active')); }); await flushP(60);
    expect(writes()).toHaveLength(2);
    expect(F().sync_error).toBeUndefined(); expect(dayTotals(st.entries).kcal).toBe(serverTotal());
  });
  test('the next successful request: a new save gets through, so the flagged row is retried at once', async () => {
    seed220(); server.fail = true;
    await boot([flaggedEdit()]);
    server.fail = false;
    await act(async () => { st.addEntries([tableEntry('N', 'dal', 1, 'katori')]); }); await flushP(80);
    expect(writes()).toEqual(['POST /v1/entries F', 'POST /v1/entries N', 'POST /v1/entries F']);
    expect(server.log).toContain('PATCH /v1/entries/F');
    expect(F().sync_error).toBeUndefined(); expect(counted(F())).toBe(true);
    expect(dayTotals(st.entries).kcal).toBe(serverTotal());
  });
  test('a flagged delete retries by itself too: gone on both once it gets through', async () => {
    seed220(); server.fail = true;
    const d = { ...tableEntry('F', 'roti', 2, 'count'), server_version: 1, server_counts: { kcal: 220, protein: 7 }, deleted_at: new Date(now).toISOString(), delete_failed: true, server_failed: true, sync_error: SERVER_ERROR, sync_reason: NOT_DELETED_REASON };
    await boot([d]);
    expect(writes()).toEqual(['DELETE /v1/entries/F']);
    expect(F()).toMatchObject({ delete_failed: true }); expect(dayTotals(st.entries).kcal).toBe(220);
    server.fail = false;
    await advance(62_000);
    expect(writes()).toEqual(['DELETE /v1/entries/F', 'DELETE /v1/entries/F']);
    expect(F().delete_failed).toBeUndefined(); expect(counted(F())).toBe(false); expect(server.rows.has('F')).toBe(false);
    expect(dayTotals(st.entries).kcal).toBe(0); expect(serverTotal()).toBe(0);
  });
  test('tap-retry still works while an automatic retry is waiting', async () => {
    seed220(); server.fail = true;
    await boot([flaggedEdit()]);
    server.fail = false;
    await act(async () => { st.retrySync('F'); }); await flushP(60);
    expect(writes()).toHaveLength(2);
    expect(F().sync_error).toBeUndefined(); expect(F().sync_retrying).toBeUndefined();
    expect(dayTotals(st.entries).kcal).toBe(serverTotal());
  });
});
