// CEO (next build): every send of an edit carries the row version it was based on (automatic retry, tap-retry, the flush of a
// queue kept over an app restart). A stale version gets B1's 409 with the locked row: the phone takes the server's row (qty,
// unit, numbers) and says "Your change to … wasn’t saved. Edit it again if you still want it."; another device's newer edit is
// never overwritten. A row with no known version: the server's copy is read first; changed since the phone last saw it
// (server_counts) = the same 409 path. Plus: an edit of a row whose delete already went through says it was deleted.
import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { AppState } from 'react-native';

jest.mock('../src/lib/config', () => ({ config: { mock: false, apiUrl: 'http://api.test', mockAi: false }, flags: {} }));
let mockSaved: string | null = null;
jest.mock('../src/lib/kv', () => ({ kv: { get: async () => mockSaved, set: async (_k: string, v: string) => { mockSaved = v; } } }));
let mockN = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `id${++mockN}` }));

import { StoreProvider, Store, useStore, applyFlush, editNotSaved, DELETED_ELSEWHERE, editGone } from '../src/lib/store';
import { counted, dayTotals, entryFromItem, FoodEntry, localDate } from '../src/lib/domain';
import { parser, DISH_TABLE_VERSION, Item } from '../src/parser';
import { flush, isStaleEdit, Op, SERVER_ERROR } from '../src/lib/syncQueue';
import { ApiError, createApi } from '../src/lib/api';

const DAY = localDate();
const roti = (id: string, qty: number, extra: Partial<FoodEntry> = {}): FoodEntry => {
  const it = { ...parser.recompute('roti', qty, 'count', ''), needs_confirmation: false } as Item;
  return { ...entryFromItem(it, { id, slot: 'lunch', raw_text: `${qty} roti`, local_date: DAY, tableVersion: DISH_TABLE_VERSION }), qty, unit: 'count', ...extra };
};
const k = (qty: number) => parser.recompute('roti', qty, 'count', '').kcal.best;
const p = (qty: number) => parser.recompute('roti', qty, 'count', '').protein_g.best;
type SRow = { kcal: number; protein: number; qty: number; unit: string; version: number };
// a server with B1's rules: PATCH with a stale version -> 409 version_conflict + the locked row; without a version -> merged
const server = { rows: new Map<string, SRow>(), fail: false, log: [] as { m: string; path: string; body: any }[],
  reset() { this.rows.clear(); this.fail = false; this.log = []; },
  /** device B saves this row */
  deviceB(id: string, qty: number) { const r = this.rows.get(id)!; Object.assign(r, { qty, kcal: k(qty), protein: p(qty), version: r.version + 1 }); } };
const reply = (status: number, body: unknown = {}) => ({ ok: status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
const out = (r: SRow) => ({ version: r.version, state: 'confirmed', dish_id: 'roti', qty: r.qty, unit: r.unit, kcal_best: r.kcal, protein_best: r.protein });
async function fakeFetch(url: string, init: { method: string; body?: string }) {
  const path = url.replace('http://api.test', ''); const b = init.body ? JSON.parse(init.body) : {};
  if (path === '/v1/remembered') return reply(200, { remembered: [] });
  if (path === '/v1/dishes') return reply(200, []);
  server.log.push({ m: init.method, path, body: b });
  if (server.fail && init.method !== 'GET' && path.startsWith('/v1/entries')) return reply(503, { error: 'unavailable' });
  if (init.method === 'POST' && path === '/v1/entries') {
    const it = b.items[0]; const had = server.rows.get(it.client_id);
    if (had) return reply(200, { duplicates: [it.client_id], entries: [out(had)] });
    const r = { kcal: Number(it.kcal), protein: Number(it.protein_g ?? 0), qty: it.qty, unit: it.unit, version: 1 };
    server.rows.set(it.client_id, r); return reply(201, { entries: [out(r)] });
  }
  const id = decodeURIComponent((/^\/v1\/entries\/(.+)$/.exec(path) ?? [])[1] ?? ''); const r = server.rows.get(id);
  if (!r) return reply(404, { error: 'entry not found' });
  if (init.method === 'GET') return reply(200, out(r));
  if (init.method === 'DELETE') { server.rows.delete(id); return reply(204); }
  if (b.version != null && b.version !== r.version) return reply(409, { error: { code: 'version_conflict', version: r.version, message: 'entry changed' }, entry: out(r) });
  Object.assign(r, { kcal: Number(b.kcal ?? r.kcal), protein: Number(b.protein_g ?? r.protein), qty: b.qty ?? r.qty, unit: b.unit ?? r.unit, version: r.version + 1 });
  return reply(200, out(r));
}
const serverTotal = () => Math.round([...server.rows.values()].reduce((a, x) => a + x.kcal, 0));
const patches = () => server.log.filter((l) => l.m === 'PATCH');
let st!: Store;
function Probe() { st = useStore(); return null; }
let r!: ReactTestRenderer;
let now = Date.parse('2026-10-17T06:00:00Z');
const flushP = async (n = 30) => { for (let i = 0; i < n; i++) await act(async () => { await Promise.resolve(); }); };
const advance = async (ms: number) => { for (let t = 0; t < ms; t += 1000) { now += 1000; await act(async () => { jest.advanceTimersByTime(1000); }); await flushP(4); } await flushP(); };
async function boot(entries: FoodEntry[], queue: Op[] = []) {
  mockN = 0;
  mockSaved = JSON.stringify({ user: { id: 'u', name: 'A', email: 'a@x', idToken: 't', mock: false }, entries, queue, aiQuota: { used: 0 } });
  await act(async () => { r = create(<StoreProvider><Probe /></StoreProvider>); });
  await flushP(60);
}
beforeAll(() => { (global as unknown as { fetch: unknown }).fetch = jest.fn(fakeFetch); });
beforeEach(() => {
  server.reset();
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  jest.spyOn(AppState, 'addEventListener').mockImplementation((() => ({ remove: () => {} })) as never);
});
afterEach(async () => { await act(async () => { r?.unmount(); }); jest.restoreAllMocks(); jest.useRealTimers(); });

const NOTE3 = editNotSaved('3 pieces');
/** the phone's edit to 3 roti, based on the server's v1 (2 roti, 220), flagged after 3x 5xx: counted at 220 */
const flagged = () => roti('F', 3, { server_version: 1, server_counts: { kcal: k(2), protein: p(2) }, server_failed: true, sync_error: SERVER_ERROR });
const seed = () => server.rows.set('F', { kcal: k(2), protein: p(2), qty: 2, unit: 'count', version: 1 });
const F = () => st.entries.find((e) => e.id === 'F')!;
const inSync = () => {
  expect(st.queue).toEqual([]);
  const s = server.rows.get('F')!;
  expect({ qty: F().qty, unit: F().unit, kcal: F().kcal.best, v: F().server_version }).toEqual({ qty: s.qty, unit: s.unit, kcal: s.kcal, v: s.version });
  expect(dayTotals(st.entries).kcal).toBe(serverTotal());
};

describe('api: versions on every edit, never re-applied', () => {
  const fetchMock = jest.fn();
  const api = createApi(() => 't');
  beforeEach(() => { (global as any).fetch = fetchMock; fetchMock.mockReset(); });
  afterAll(() => { (global as any).fetch = jest.fn(fakeFetch); });
  const row2 = { version: 2, state: 'confirmed', dish_id: 'roti', qty: 4, unit: 'count', kcal_best: k(4), protein_best: p(4) };
  test('known version: the PATCH carries the edit’s base version; a 409 with the row is thrown as is (one PATCH, no re-apply)', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { duplicates: ['F'], entries: [row2] })).mockResolvedValueOnce(reply(409, { error: { code: 'version_conflict', version: 2 }, entry: row2 }));
    const err = await api.upsertEntry(roti('F', 3, { server_version: 1 })).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError); expect(err.status).toBe(409); expect(err.entry).toEqual(row2); expect(err.patch).toBe(true);
    expect(isStaleEdit(err, { kind: 'upsert', entry: roti('F', 3), tries: 0 })).toBe(true);
    expect(fetchMock.mock.calls.map((c) => c[1].method)).toEqual(['POST', 'PATCH']);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).version).toBe(1); // the base, not the POST's current 2
  });
  test('no known version, the server’s copy as the phone last saw it: PATCH with the version just read', async () => {
    const row1 = { ...row2, version: 7, qty: 2, kcal_best: k(2), protein_best: p(2) };
    fetchMock.mockResolvedValueOnce(reply(200, { duplicates: ['F'], entries: [row1] })).mockResolvedValueOnce(reply(200, row1)).mockResolvedValueOnce(reply(200, { ...row1, version: 8, qty: 3 }));
    await api.upsertEntry(roti('F', 3, { server_counts: { kcal: k(2), protein: p(2) } }));
    expect(fetchMock.mock.calls.map((c) => c[1].method)).toEqual(['POST', 'GET', 'PATCH']);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).version).toBe(7);
  });
  test('no known version, the server’s copy changed since (another device): the 409 path, nothing written', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { duplicates: ['F'], entries: [row2] })).mockResolvedValueOnce(reply(200, row2));
    const err = await api.upsertEntry(roti('F', 3, { server_counts: { kcal: k(2), protein: p(2) } })).catch((e) => e);
    expect(err.status).toBe(409); expect(err.code).toBe('version_conflict'); expect(err.entry).toEqual(row2); expect(err.patch).toBe(true);
    expect(fetchMock.mock.calls.map((c) => c[1].method)).toEqual(['POST', 'GET']);
  });
  test('no known version and the row is gone (404 on the read): deleted elsewhere (the delete wins)', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { duplicates: ['F'], entries: [row2] })).mockResolvedValueOnce(reply(404, { error: 'entry not found' }));
    const err = await api.upsertEntry(roti('F', 3)).catch((e) => e);
    expect(err.status).toBe(404); expect(err.patch).toBe(true);
  });
  test('an older server’s 409 without its row: the row is read, then the same 409 path', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { duplicates: ['F'], entries: [row2] })).mockResolvedValueOnce(reply(409, { error: { code: 'version_conflict' } })).mockResolvedValueOnce(reply(200, row2));
    const err = await api.upsertEntry(roti('F', 3, { server_version: 1 })).catch((e) => e);
    expect(err.entry).toEqual(row2); expect(fetchMock.mock.calls.map((c) => c[1].method)).toEqual(['POST', 'PATCH', 'GET']);
  });
});

describe('flush + applyFlush (pure)', () => {
  const row4 = { version: 2, state: 'confirmed', dish_id: 'roti', qty: 4, unit: 'count', kcal_best: k(4), protein_best: p(4) };
  const stale409 = () => Object.assign(new ApiError(409, JSON.stringify({ error: { code: 'version_conflict', version: 2 }, entry: row4 })), { patch: true });
  test('a stale edit leaves the queue (later ops flow) and comes back as stale', async () => {
    const e = roti('F', 3, { server_version: 1 }), g = roti('G', 1);
    const q: Op[] = [{ kind: 'upsert', entry: e, tries: 0, auto: true, fives: 2 }, { kind: 'upsert', entry: g, tries: 0 }];
    const res = await flush(q, { upsertEntry: async (x) => { if (x.id === 'F') throw stale409(); return { version: 1 }; }, deleteEntry: async () => {}, resolvePending: async () => null, deleteRemembered: async () => {} }, now);
    expect(res.stale).toEqual([{ id: 'F', row: row4, sent: e }]); expect(res.rest).toEqual([]); expect(res.failed).toEqual([]); expect(res.versions).toEqual({ G: 1 });
  });
  test('applyFlush: the server’s row (qty, unit, numbers, version), the note, flags cleared; shown == counted == server', () => {
    const e = flagged();
    const out1 = applyFlush({ entries: [e], queue: [] as Op[] }, [], { rest: [], resolved: [], rejected: [], versions: {}, failed: [], stale: [{ id: 'F', row: row4, sent: e }] } as never).entries[0];
    expect(out1).toMatchObject({ qty: 4, unit: 'count', server_version: 2, server_counts: { kcal: k(4), protein: p(4) }, server_note: NOTE3 });
    expect(out1.kcal.best).toBe(k(4)); expect(out1.sync_error).toBeUndefined(); expect(out1.server_failed).toBeUndefined();
    expect(dayTotals([out1]).kcal).toBe(Math.round(k(4)));
    // the server already has exactly this edit: adopted, no note
    const same = { ...row4, qty: 3, kcal_best: k(3), protein_best: p(3) };
    const out2 = applyFlush({ entries: [e], queue: [] as Op[] }, [], { rest: [], resolved: [], rejected: [], versions: {}, failed: [], stale: [{ id: 'F', row: same, sent: e }] } as never).entries[0];
    expect(out2.server_note).toBeUndefined(); expect(out2).toMatchObject({ qty: 3, server_version: 2 });
    // the user edited again since: that newer edit is left alone (its own op carries the same old base -> its own 409)
    const newer = { ...roti('F', 5, { server_version: 1 }), updated_at: 'later' };
    const out3 = applyFlush({ entries: [newer], queue: [] as Op[] }, [], { rest: [], resolved: [], rejected: [], versions: {}, failed: [], stale: [{ id: 'F', row: row4, sent: e }] } as never).entries[0];
    expect(out3).toBe(newer);
  });
  test('editGone: deleted, not flagged, nothing queued', () => {
    const d = roti('F', 2, { deleted_at: 'x' });
    expect(editGone({ entries: [d], queue: [] }, 'F')).toBe(true);
    expect(editGone({ entries: [{ ...d, delete_failed: true }], queue: [] }, 'F')).toBe(false);
    expect(editGone({ entries: [d], queue: [{ kind: 'delete', id: 'F', tries: 0 }] }, 'F')).toBe(false);
    expect(editGone({ entries: [roti('F', 2)], queue: [] }, 'F')).toBe(false);
  });
});

describe('store: device B edits while device A’s edit is flagged / queued', () => {
  test('automatic retry: B’s edit wins; A shows the server’s row (4 pieces) and the note; phone == server; nothing re-sent', async () => {
    seed(); server.fail = true;
    await boot([flagged()]);
    expect(patches().length + server.log.filter((l) => l.m === 'POST').length).toBeGreaterThan(0); // app-start retry (503)
    server.deviceB('F', 4); server.fail = false; server.log = [];
    await advance(62_000); // the automatic retry
    expect(patches().map((l) => l.body.version)).toEqual([1]); // based on v1, sent once
    expect(server.rows.get('F')).toMatchObject({ qty: 4, version: 2 });
    expect(F()).toMatchObject({ qty: 4, unit: 'count', server_note: NOTE3 }); expect(F().sync_error).toBeUndefined(); expect(F().server_failed).toBeUndefined();
    inSync();
    await advance(30 * 60_000); expect(patches()).toHaveLength(1);
  });
  test('tap-retry: the same', async () => {
    seed(); server.fail = true;
    await boot([flagged()]);
    server.deviceB('F', 4); server.fail = false; server.log = [];
    await act(async () => { st.retrySync('F'); }); await flushP(80);
    expect(patches().map((l) => l.body.version)).toEqual([1]);
    expect(F()).toMatchObject({ qty: 4, server_note: NOTE3 }); inSync();
  });
  test('a queued edit kept over an app restart: flushed at start with its base version -> the same', async () => {
    seed(); server.deviceB('F', 4);
    const e = roti('F', 3, { server_version: 1, server_counts: { kcal: k(2), protein: p(2) } });
    await boot([e], [{ kind: 'upsert', entry: e, tries: 0 }]);
    await flushP(60);
    expect(patches().map((l) => l.body.version)).toEqual([1]);
    expect(F()).toMatchObject({ qty: 4, server_note: NOTE3 }); inSync();
  });
  test('nobody else saved: the retry (based on v1) lands; no note', async () => {
    seed(); server.fail = true;
    await boot([flagged()]);
    server.fail = false; server.log = [];
    await advance(62_000);
    expect(patches().map((l) => l.body.version)).toEqual([1]);
    expect(server.rows.get('F')).toMatchObject({ qty: 3, version: 2 }); expect(F().server_note).toBeUndefined(); inSync();
  });
  test('every PATCH the phone sends carries a version', async () => {
    seed();
    await boot([roti('F', 2, { server_version: 1, server_counts: { kcal: k(2), protein: p(2) } })]);
    for (const q of [3, 4, 5]) { await act(async () => { st.updateEntry({ ...F(), ...roti('F', q), server_version: F().server_version }); }); await flushP(60); }
    expect(patches().length).toBe(3); expect(patches().every((l) => typeof l.body.version === 'number')).toBe(true);
    expect(server.rows.get('F')).toMatchObject({ qty: 5 }); expect(F().server_note).toBeUndefined(); inSync();
  });
  test('a row with no known version (older build): read first; changed since -> the server’s row + the note; unchanged -> saved', async () => {
    seed(); server.deviceB('F', 4);
    const old = roti('F', 3, { server_counts: { kcal: k(2), protein: p(2) } }); // no server_version
    await boot([old], [{ kind: 'upsert', entry: old, tries: 0 }]);
    expect(server.log.some((l) => l.m === 'GET' && l.path === '/v1/entries/F')).toBe(true);
    expect(patches()).toHaveLength(0);
    expect(F()).toMatchObject({ qty: 4, server_note: NOTE3, server_version: 2 }); inSync();
    await act(async () => { r.unmount(); });
    server.reset(); seed();
    await boot([old], [{ kind: 'upsert', entry: old, tries: 0 }]);
    expect(patches().map((l) => l.body.version)).toEqual([1]);
    expect(F()).toMatchObject({ qty: 3 }); expect(F().server_note).toBeUndefined(); inSync();
  });
  test('an edit of a row whose delete already went through: refused with "deleted on another device", nothing queued', async () => {
    seed();
    const d = roti('F', 2, { server_version: 1, deleted_at: new Date(now).toISOString() });
    server.rows.delete('F');
    await boot([d]);
    let why: string | null = null;
    await act(async () => { why = st.updateEntry({ ...d, ...roti('F', 3), deleted_at: null }); });
    expect(why).toBe(DELETED_ELSEWHERE); expect(DELETED_ELSEWHERE).toBe('This entry was deleted on another device.');
    expect(st.queue).toEqual([]); expect(counted(F())).toBe(false);
  });
});
