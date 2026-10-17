// next build, rg10 5xx-path notes T3b, Progress label, streak, N4 (T2 auto retry: autoRetry.test.tsx). Same fake server.
import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { AppState } from 'react-native';

jest.mock('../src/lib/config', () => ({ config: { mock: false, apiUrl: 'http://api.test', mockAi: false }, flags: {} }));
let mockSaved: string | null = null;
jest.mock('../src/lib/kv', () => ({ kv: { get: async () => mockSaved, set: async (_k: string, v: string) => { mockSaved = v; } } }));
let mockN = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `id${++mockN}` }));

import { StoreProvider, Store, useStore, editedState } from '../src/lib/store';
import { counted, dayTotals, entryFromItem, FoodEntry, localDate } from '../src/lib/domain';
import { parser, DISH_TABLE_VERSION, Item } from '../src/parser';
import Progress from '../src/app/(tabs)/progress';
import { NOT_DELETED_REASON, Op, SERVER_ERROR } from '../src/lib/syncQueue';

const DAY = localDate();
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
async function boot(entries: FoodEntry[], queue: Op[] = [], ui?: React.ReactNode) {
  mockN = 0;
  mockSaved = JSON.stringify({ user: { id: 'u', name: 'A', email: 'a@x', idToken: 't', mock: false }, entries, queue, aiQuota: { used: 0 } });
  await act(async () => { r = create(<StoreProvider><Probe />{ui}</StoreProvider>); });
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

const seed220 = () => server.rows.set('F', { kcal: 220, protein: 7, qty: 2, unit: 'count', version: 1 });
const F = () => st.entries.find((e) => e.id === 'F')!;
const roti2 = () => ({ ...tableEntry('F', 'roti', 2, 'count'), server_version: 1, server_counts: { kcal: 220, protein: 7 } });
const flaggedDelete = () => ({ ...roti2(), deleted_at: new Date(now).toISOString(), delete_failed: true, server_failed: true, sync_error: SERVER_ERROR, sync_reason: NOT_DELETED_REASON });
const edit = (base: FoodEntry, qty: number): FoodEntry => { const it = parser.recompute('roti', qty, 'count', ''); return { ...base, qty, kcal: it.kcal, protein_g: it.protein_g, carbs_g: it.carbs_g, fat_g: it.fat_g }; };
const k = (qty: number) => parser.recompute('roti', qty, 'count', '').kcal.best;

describe('T3b: editing a flagged row never leaves a stale delete flag (shown == counted == queued == server)', () => {
  test('pure: an edit of a flagged delete replaces it: live, no delete_failed / unsynced_edit, its delete op replaced by the upsert, counted as the server has it until it syncs', () => {
    const d = { ...flaggedDelete(), unsynced_edit: true };
    const p = editedState({ entries: [d], queue: [{ kind: 'delete', id: 'F', tries: 0, fives: 2, auto: true }] as Op[] }, edit(d, 3));
    const n = p.entries[0];
    expect(n.deleted_at).toBeNull(); expect(n.delete_failed).toBeUndefined(); expect(n.unsynced_edit).toBeUndefined(); expect(n.sync_error).toBeUndefined();
    expect(n).toMatchObject({ qty: 3, server_version: 1, server_failed: true, server_counts: { kcal: 220, protein: 7 } });
    expect(p.queue).toEqual([{ kind: 'upsert', entry: n, tries: 0 }]);
    expect(counted(n)).toBe(true); expect(dayTotals(p.entries).kcal).toBe(220);
  });
  test('pure: the sync state is the store’s current one, not the copy the sheet opened with', () => {
    const opened = { ...roti2(), qty: 3, server_failed: true, sync_error: SERVER_ERROR }; // sheet opened on the flagged row
    const now2 = { ...roti2(), qty: 3, kcal: { low: 300, best: 330, high: 360 }, server_version: 2, server_counts: { kcal: 330, protein: 10 } }; // a retry got through since
    const n = editedState({ entries: [now2], queue: [] as Op[] }, edit(opened, 4)).entries[0];
    expect(n.server_failed).toBeUndefined(); expect(n.server_version).toBe(2); expect(n.server_counts).toEqual({ kcal: 330, protein: 10 });
    expect(n.sync_error).toBeUndefined(); expect(dayTotals([n]).kcal).toBe(Math.round(k(4)));
    // and the other way: flagged (delete) after the sheet opened -> the edit replaces that delete
    const later = flaggedDelete();
    const m = editedState({ entries: [later], queue: [] as Op[] }, edit(roti2(), 3)).entries[0];
    expect(m.delete_failed).toBeUndefined(); expect(m.deleted_at).toBeNull(); expect(m.server_failed).toBe(true);
  });
  test('pure: a row whose delete already went through stays deleted; nothing is queued', () => {
    const gone = { ...roti2(), deleted_at: 'x' };
    const p = { entries: [gone], queue: [] as Op[] };
    expect(editedState(p, edit(gone, 3))).toBe(p);
  });
  test('store: flagged delete, then an edit to 3 roti: no stale flag; once synced phone == server (330), the delete never sent', async () => {
    seed220(); server.fail = true;
    await boot([flaggedDelete()]);
    expect(F().delete_failed).toBe(true); // the app-start retry failed
    server.fail = false; server.log = [];
    await act(async () => { st.updateEntry(edit(F(), 3)); }); await flushP(80);
    expect(F().delete_failed).toBeUndefined(); expect(F().deleted_at).toBeNull(); expect(F().sync_error).toBeUndefined(); expect(F().server_failed).toBeUndefined();
    expect(server.log.filter((l) => l.startsWith('DELETE'))).toEqual([]);
    expect(server.rows.get('F')).toMatchObject({ qty: 3, kcal: k(3) });
    expect(st.queue).toHaveLength(0);
    expect(dayTotals(st.entries).kcal).toBe(serverTotal()); expect(serverTotal()).toBe(Math.round(k(3)));
  });
  test('store: the server is still down when the edit is made: counted at the server’s 220 (no delete flag) until it gets through', async () => {
    seed220(); server.fail = true;
    await boot([flaggedDelete()]);
    await act(async () => { st.updateEntry(edit(F(), 3)); }); await flushP(80);
    expect(F().delete_failed).toBeUndefined(); expect(F().deleted_at).toBeNull();
    expect(dayTotals(st.entries).kcal).toBe(220); expect(serverTotal()).toBe(220);
    expect(st.queue.map((o) => o.kind)).toEqual(['upsert']);
    server.fail = false;
    await advance(70_000);
    expect(F().server_failed).toBeUndefined(); expect(dayTotals(st.entries).kcal).toBe(serverTotal()); expect(serverTotal()).toBe(Math.round(k(3)));
  });
  test('Progress: a row the server hasn’t confirmed shows the kcal it counts (shown == counted)', async () => {
    const y = new Date(now - 86_400_000).toISOString().slice(0, 10);
    const row = { ...edit(roti2(), 3), local_date: y, server_failed: true };
    server.rows.set('F', { kcal: 220, protein: 7, qty: 2, unit: 'count', version: 1 }); server.fail = true;
    await boot([row], [], <Progress />);
    const day = r.root.findAll((x) => typeof x.props.accessibilityLabel === 'string' && /, 1 items?, /.test(x.props.accessibilityLabel));
    if (!day.length) throw new Error(JSON.stringify(r.root.findAll((x) => typeof x.props.accessibilityLabel === 'string').map((x) => x.props.accessibilityLabel)));
    expect(day[0].props.accessibilityLabel).toContain('220 calories');
    await act(async () => { day[0].props.onPress(); });
    const nums = r.root.findAll((x) => typeof x.type === 'string').flatMap((x) => [x.props.children].flat()).filter((c) => typeof c === 'string');
    expect(nums).toContain('220'); expect(nums).not.toContain(String(Math.round(k(3))));
  });
});

import { SYNC_FAILED_COPY, syncFailedLabel } from '../src/components/SyncFailedRow';
describe('Progress: a flagged row whose tap retries says "Tap to retry", never "Edit"', () => {
  const y = () => new Date(now - 86_400_000).toISOString().slice(0, 10);
  const open = async () => {
    const day = r.root.findAll((x) => typeof x.props.accessibilityLabel === 'string' && /, \d+ items?, /.test(x.props.accessibilityLabel) && typeof x.props.onPress === 'function');
    await act(async () => { day[0].props.onPress(); });
  };
  const labels = () => r.root.findAll((x) => typeof x.props.accessibilityLabel === 'string' && typeof x.props.onPress === 'function').map((x) => x.props.accessibilityLabel as string);
  test('the flagged delete: Today’s exact wording (with the reason); tapping it retries; a normal row still says Edit', async () => {
    seed220(); server.fail = true;
    const d = { ...flaggedDelete(), local_date: y(), slot: 'breakfast' as const };
    const g = { ...tableEntry('G', 'dal', 1, 'katori'), local_date: y(), server_version: 1 };
    server.rows.set('G', { kcal: g.kcal.best, protein: g.protein_g.best, qty: 1, unit: 'katori', version: 1 });
    await boot([d, g], [], <Progress />);
    await open();
    const want = `Breakfast · roti (deleted): couldn’t sync this. Tap to retry. ${NOT_DELETED_REASON}`;
    expect(syncFailedLabel('Breakfast · roti (deleted)', { reason: NOT_DELETED_REASON })).toBe(want);
    expect(want.toLowerCase()).toContain(SYNC_FAILED_COPY.toLowerCase());
    expect(labels()).toContain(want);
    expect(labels().filter((l) => /^Edit /.test(l))).toEqual(['Edit Dal']);
    expect(labels().some((l) => /^Edit roti/i.test(l))).toBe(false);
    // tap: retried (server back -> the delete goes through, gone on both)
    server.fail = false; server.log = [];
    const row = r.root.findAll((x) => x.props.accessibilityLabel === want && typeof x.props.onPress === 'function')[0];
    await act(async () => { row.props.onPress(); }); await flushP(80);
    expect(server.log).toContain('DELETE /v1/entries/F');
    expect(F().delete_failed).toBeUndefined(); expect(server.rows.has('F')).toBe(false);
    expect(Math.round(dayTotals(st.entries.filter((e) => e.local_date === y())).kcal)).toBe(serverTotal());
  });
  test('while the retry runs it says "retrying sync" and is busy (like Today’s row)', async () => {
    seed220(); server.fail = true;
    const d = { ...flaggedDelete(), local_date: y(), slot: 'breakfast' as const, sync_error: undefined, sync_retrying: true };
    await boot([d], [{ kind: 'delete', id: 'F', tries: 1, fives: 1, nextAt: now + 3_600_000 } as Op], <Progress />);
    await open();
    if (!labels().length) throw new Error('no rows');
    const want = syncFailedLabel('Breakfast · roti (deleted)', { retrying: true });
    expect(want).toBe('Breakfast · roti (deleted): retrying sync');
    const row = r.root.findAll((x) => x.props.accessibilityLabel === want && typeof x.props.onPress === 'function');
    expect(row.length).toBeGreaterThan(0); expect(row[0].props.accessibilityState).toEqual({ busy: true });
  });
});
