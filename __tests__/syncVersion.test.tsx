// Tester rg2 (Oct 17): no phone-clock precondition, versions from the server, a 409 never jams the queue, a typed kcal
// after job_abandoned always lands, and the 1-5000 store guard. Runs the REAL store against a fake server that follows
// the backend contract (19a8517 / da5ccc6): row versions, version_conflict, job_abandoned for AI-source writes only,
// kcal 0-5000, summary = confirmed, not deleted. After every sync: phone == server == /v1/summary, queue empty.
import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';

jest.mock('../src/lib/config', () => ({ config: { mock: false, apiUrl: 'http://api.test', mockAi: false }, flags: {} }));
let mockSaved: string | null = null;
jest.mock('../src/lib/kv', () => ({ kv: { get: async () => mockSaved, set: async (_k: string, v: string) => { mockSaved = v; } } }));
let mockN = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `id${++mockN}` }));
jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual('react-native');
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});

import { applyFlush, DELETED_ELSEWHERE, StoreProvider, Store, useStore } from '../src/lib/store';
import { NoticeToast } from '../src/components/NoticeToast';
import type { Op } from '../src/lib/syncQueue';
import { counted, dayTotals, FoodEntry, reviewEntry, savableEntry, validTypedKcal } from '../src/lib/domain';
import { parser, DISH_TABLE_VERSION } from '../src/parser';
import { TextInput } from 'react-native';
import { FailedAiRow } from '../src/components/LogRows';
import { failedCounts } from '../src/lib/aiRows';

const DAY = '2026-10-17';
type Row = { client_id: string; version: number; kcal: number; state: string; source: string; custom_name: string; deleted: boolean; job?: string };
type Hold = { release: () => void };
const server = {
  rows: new Map<string, Row>(), abandoned: new Set<string>(), held: [] as Hold[], holdNext: 0, foreignBump: 0, alwaysConflict: new Set<string>(), refuse: new Set<string>(), log: [] as string[], offline: false,
  reset() { this.rows.clear(); this.abandoned.clear(); this.held = []; this.holdNext = 0; this.foreignBump = 0; this.alwaysConflict.clear(); this.refuse.clear(); this.log = []; this.offline = false; },
  /** device 2 deletes the row */
  remoteDelete(id: string) { const r = this.rows.get(id)!; r.deleted = true; r.version++; },
  summary() { return [...this.rows.values()].filter((r) => !r.deleted && r.state === 'confirmed').reduce((s, r) => s + r.kcal, 0); },
};
const reply = (status: number, body: unknown = {}) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const view = (r: Row) => ({ client_id: r.client_id, version: r.version, kcal_best: r.kcal, state: r.state, source: r.source, custom_name: r.custom_name });
async function fakeFetch(url: string, init: { method: string; body?: string }) {
  const path = url.replace('http://api.test', ''); const b = init.body ? JSON.parse(init.body) : {};
  if (init.method !== 'GET' && server.holdNext > 0) { server.holdNext--; await new Promise<void>((res) => server.held.push({ release: res })); } // a slow request
  if (server.offline) throw new TypeError('Network request failed');
  server.log.push(`${init.method} ${path}`);
  if (b.if_unmodified_since !== undefined) throw new Error('the phone clock must never be sent as a precondition');
  if (path === '/v1/remembered') return reply(200, { remembered: [] });
  if (/\/abandon$/.test(path)) return reply(200, { status: 'abandoned' });
  if (init.method === 'POST' && path === '/v1/entries') {
    const it = b.items[0]; const ex = server.rows.get(it.client_id);
    if (ex) return reply(200, { entries: [view(ex)], duplicates: [it.client_id] });
    if (it.source === 'ai_estimate' && it.parse_job_id && server.abandoned.has(it.parse_job_id)) return reply(409, { error: { code: 'job_abandoned' } });
    // food.go resolve: a table row (dish_id, not AI / typed) at any size; every other row 0-5000
    if (it.state !== 'needs_review' && !(it.dish_id && it.source !== 'ai_estimate' && it.source !== 'custom') && !(it.kcal >= 0 && it.kcal <= 5000)) return reply(400, { error: 'this item needs kcal (0-5000)' });
    const r: Row = { client_id: it.client_id, version: 1, kcal: it.state === 'needs_review' ? 0 : it.kcal, state: it.state ?? 'confirmed', source: it.source,
      custom_name: it.custom_name ?? '', deleted: false, job: it.parse_job_id };
    server.rows.set(r.client_id, r); return reply(201, { entries: [view(r)] });
  }
  const m = /^\/v1\/entries\/(.+)$/.exec(path); const r = m && server.rows.get(decodeURIComponent(m[1]));
  if (!r || r.deleted) return reply(404, { error: 'entry not found' });
  if (init.method === 'DELETE') { r.deleted = true; r.version++; return reply(204); }
  // PATCH
  if (server.foreignBump > 0) { server.foreignBump--; r.version++; } // another write landed on the server first
  if (server.refuse.has(r.client_id)) return reply(403, { error: { code: 'forbidden', message: 'locked' } });
  if (server.alwaysConflict.has(r.client_id) || (b.version != null && b.version !== r.version)) return reply(409, { error: { code: 'version_conflict', version: r.version }, entry: view(r) });
  const state = b.state ?? r.state; const src = b.kcal != null ? 'custom' : r.source;
  if ((b.source === 'ai_estimate' || (src === 'ai_estimate' && b.kcal == null && state !== 'needs_review')) && server.abandoned.has(b.parse_job_id ?? r.job ?? '')) return reply(409, { error: { code: 'job_abandoned' } });
  if (b.kcal != null && !b.dish_id && !(b.kcal >= 0 && b.kcal <= 5000)) return reply(400, { error: 'this item needs kcal (0-5000)' });
  Object.assign(r, { kcal: state === 'needs_review' ? 0 : (b.kcal ?? r.kcal), state, source: src, custom_name: b.custom_name ?? r.custom_name, version: r.version + 1 });
  return reply(200, view(r));
}

let st!: Store;
function Probe() { st = useStore(); return null; }
const tick = async (n = 12) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((res) => setTimeout(res, 0)); }); };
const settle = async () => { for (let i = 0; i < 40 && (st.queue.length || server.held.length); i++) await tick(2); await tick(); };
const ent = (id: string) => st.entries.find((e) => e.id === id)!;
/** phone == server == summary, queue empty, no sync errors */
function expectInSync() {
  expect(st.queue).toEqual([]);
  const phone = st.entries.filter((e) => e.local_date === DAY);
  for (const e of phone) {
    const r = server.rows.get(e.id);
    if (e.deleted_at) { expect(!r || r.deleted).toBe(true); continue; }
    expect(r).toBeDefined(); expect(e.sync_error).toBeUndefined();
    expect({ id: e.id, kcal: counted(e) ? e.kcal.best : 0, state: e.needs_review ? 'needs_review' : 'confirmed' }).toEqual({ id: e.id, kcal: r!.kcal, state: r!.state });
    expect(e.server_version).toBe(r!.version);
  }
  expect(dayTotals(phone.filter(counted)).kcal).toBe(server.summary());
}
const custom = (id: string, kcal: number): FoodEntry => {
  const now = new Date().toISOString();
  return { id, local_date: DAY, slot: 'lunch', raw_text: id, dish_id: null, custom_name: id, qty: 1, unit: 'count', oil_level: '', kcal: { low: kcal, best: kcal, high: kcal },
    protein_g: { low: 0, best: 0, high: 0 }, source: 'custom', source_note: 'Your entry', confirmed: true, dish_table_version: DISH_TABLE_VERSION, created_at: now, updated_at: now, deleted_at: null };
};
const failedRow = (id: string): FoodEntry => ({ ...reviewEntry(parser.unknown('zorbu'), { id, slot: 'dinner', raw_text: 'zorbu', local_date: DAY, tableVersion: DISH_TABLE_VERSION }), custom_name: 'zorbu', span: 'zorbu' });
let r!: ReactTestRenderer;
async function boot() {
  server.reset(); mockN = 0;
  mockSaved = JSON.stringify({ user: { id: 'u', name: 'A', email: 'a@x', idToken: 't', mock: false }, entries: [], queue: [], aiQuota: { used: 0 } });
  await act(async () => { r = create(<StoreProvider><Probe /><NoticeToast /></StoreProvider>); });
  await tick();
  await act(async () => { st.addEntries([custom('C', 300), failedRow('R')]); });
  await settle(); expectInSync();
}
beforeAll(() => { (global as unknown as { fetch: unknown }).fetch = jest.fn(fakeFetch); });
afterEach(async () => { await act(async () => { r?.unmount(); }); jest.useRealTimers(); });

type Act = (s: Store) => void;
const K = (kcal: number): Act => (s) => s.confirmReviewKcal('R', kcal);
const U = (kcal: number): Act => (s) => s.updateEntry({ ...s.entries.find((e) => e.id === 'C')!, kcal: { low: kcal, best: kcal, high: kcal } });
const D = (id: string): Act => (s) => s.deleteEntry(id);
// Tester item 4: the first op is in flight (slow), the second arrives meanwhile
const CASES: [string, Act, Act][] = [
  ['I1 typed kcal, then typed again', K(450), K(470)], ['I2 edit, then edit again', U(480), U(520)], ['I3 typed kcal, then edit', K(450), U(480)],
  ['I4 edit, then typed kcal', U(480), K(450)], ['I5 delete, then typed kcal', D('C'), K(450)], ['I6 typed kcal, then delete it', K(450), D('R')],
  ['I7 edit, then delete it', U(480), D('C')], ['I8 delete review row, then edit', D('R'), U(480)], ['I9 edit, delete, typed kcal', U(480), (s) => { s.deleteEntry('C'); s.confirmReviewKcal('R', 300); }],
];
describe.each([['clock right', 0], ['phone clock 60 s slow', -60_000], ['phone clock 60 s fast', 60_000]])('sync race (%s)', (_n, skew) => {
  test.each(CASES)('%s: phone == server == summary, nothing stuck', async (_name, first, second) => {
    jest.useFakeTimers({ doNotFake: ['setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'queueMicrotask', 'nextTick'] });
    jest.setSystemTime(Date.now() + (skew as number));
    await boot();
    server.holdNext = 1;
    await act(async () => { first(st); });
    await tick(4);
    expect(server.held).toHaveLength(1); // the first op is in flight
    await act(async () => { second(st); });
    await act(async () => { server.held.splice(0).forEach((h) => h.release()); });
    await settle();
    expectInSync();
    expect(server.log.filter((l) => l.startsWith('PATCH')).length).toBeLessThanOrEqual(6); // no retry storm
  });
});

test('CEO (next build): another write moved the server version: never re-applied; the phone takes the server’s row and says the edit wasn’t saved', async () => {
  await boot();
  server.foreignBump = 1; // another device saved C (still 300) since the phone last saw it
  await act(async () => { U(610)(st); });
  await settle();
  expect(server.rows.get('C')).toMatchObject({ kcal: 300 }); // the other write stands
  expect(server.log.filter((l) => l === 'PATCH /v1/entries/C')).toHaveLength(1); // no re-apply
  expect(ent('C').kcal.best).toBe(300); expect(ent('C').server_note).toBe('Your change to 610 kcal wasn’t saved. Edit it again if you still want it.');
  expectInSync();
  // editing again (now on the server's version) saves
  await act(async () => { U(640)(st); }); await settle();
  expect(server.rows.get('C')).toMatchObject({ kcal: 640 }); expect(ent('C').server_note).toBeUndefined();
  expectInSync();
});

test('a stale version every time: only that row is affected (the server’s row + the note), later ops keep flowing, nothing jammed', async () => {
  await boot();
  server.alwaysConflict.add('C');
  await act(async () => { U(700)(st); st.confirmReviewKcal('R', 250); });
  await settle();
  expect(st.queue).toEqual([]);
  expect(ent('C').sync_error).toBeUndefined(); expect(ent('C').kcal.best).toBe(300);
  expect(ent('C').server_note).toBe('Your change to 700 kcal wasn’t saved. Edit it again if you still want it.');
  expect(server.rows.get('R')).toMatchObject({ kcal: 250, state: 'confirmed' });
  expect(server.log.filter((l) => l === 'PATCH /v1/entries/C')).toHaveLength(1);
  expectInSync();
});

test('retry spinner (Designer Oct 17): retrying while the op is in flight, the kcal still counts; cleared when it syncs or fails again', async () => {
  await boot();
  server.refuse.add('C');
  await act(async () => { U(700)(st); });
  await settle();
  expect(ent('C')).toMatchObject({ sync_error: 'forbidden' });
  const phoneKcal = () => dayTotals(st.entries.filter((e) => e.local_date === DAY && counted(e))).kcal;
  expect(phoneKcal()).toBe(700); // the failed row still counts on the phone
  // retry that fails again: retrying while in flight, then back to the failed state (no spinner)
  server.holdNext = 1;
  await act(async () => { st.retrySync('C'); });
  await tick(4);
  expect(server.held).toHaveLength(1);
  expect(ent('C').sync_retrying).toBe(true); expect(ent('C').sync_error).toBeUndefined();
  expect(phoneKcal()).toBe(700);
  await act(async () => { st.retrySync('C'); }); // a second tap while retrying does nothing
  expect(st.queue.filter((o) => o.kind === 'upsert')).toHaveLength(1);
  await act(async () => { server.held.splice(0).forEach((h) => h.release()); });
  await settle();
  expect(ent('C').sync_retrying).toBeUndefined(); expect(ent('C').sync_error).toBe('forbidden');
  expect(phoneKcal()).toBe(700);
  // retry that succeeds: spinner while in flight, then a normal synced row
  server.refuse.clear(); server.holdNext = 1;
  await act(async () => { st.retrySync('C'); });
  await tick(4);
  expect(ent('C').sync_retrying).toBe(true);
  await act(async () => { server.held.splice(0).forEach((h) => h.release()); });
  await settle();
  expect(ent('C').sync_retrying).toBeUndefined(); expect(ent('C').sync_error).toBeUndefined();
  expectInSync();
  expect(phoneKcal()).toBe(700);
});

test('retry spinner on a delete (no version comes back): cleared when the delete is done, or back to failed', () => {
  const del = { kind: 'delete', id: 'C', tries: 0 } as Op;
  const e = { ...custom('C', 300), deleted_at: '2026-10-17T05:00:00Z', sync_retrying: true };
  const none = { rest: [], resolved: [], rejected: [], versions: {}, failed: [] };
  expect(applyFlush({ entries: [e], queue: [del] }, [del], none).entries[0].sync_retrying).toBeUndefined();
  const again = applyFlush({ entries: [e], queue: [del] }, [del], { ...none, failed: [{ id: 'C', code: 'http_403' }] }).entries[0];
  expect(again).toMatchObject({ sync_error: 'http_403' }); expect(again.sync_retrying).toBeUndefined();
  // a flush that did not send this row's op (still queued) keeps the spinner
  const other = { kind: 'delete', id: 'X', tries: 0 } as Op;
  expect(applyFlush({ entries: [e], queue: [other, del] }, [other], { ...none, rest: [] }).entries[0].sync_retrying).toBe(true);
});

const aiRow = (id: string, kcal: number): FoodEntry => ({ ...custom(id, kcal), custom_name: 'wedding plate', raw_text: 'wedding plate', source: 'ai', source_note: 'AI estimate', qty: 1 });
describe('F1 (rg4): the app refuses up front what the server would refuse; a PATCH refusal never rewrites the row', () => {
  test('AI 2000 x3 = 6000 is refused with the message and nothing is sent; x2 = 4000 saves and syncs equal', async () => {
    await boot();
    await act(async () => { st.addEntries([aiRow('W', 2000)]); });
    await settle(); expectInSync();
    const n = server.log.length;
    let why: string | null = null;
    await act(async () => { why = st.updateEntry({ ...ent('W'), qty: 3, kcal: { low: 6000, best: 6000, high: 6000 } }); });
    expect(why).toBe('That’s too much for one entry. Try a smaller amount.'); // Designer Oct 17: an AI row scaled past 5000
    await settle();
    expect(server.log.length).toBe(n); // nothing sent
    expect(ent('W').kcal.best).toBe(2000);
    expect(st.queue).toEqual([]);
    await act(async () => { why = st.updateEntry({ ...ent('W'), qty: 2, kcal: { low: 4000, best: 4000, high: 4000 } }); });
    expect(why).toBeNull();
    await settle();
    expect(server.rows.get('W')).toMatchObject({ kcal: 4000, state: 'confirmed' });
    expectInSync(); // phone == server == summary
  });
  test('the exact F1 sequence (a 6000 edit queued by 36624fa reaches the server): 400 keeps the phone value, flags the row with the reason, the queue flows', async () => {
    await boot();
    await act(async () => { st.addEntries([aiRow('W', 2000)]); });
    await settle(); expectInSync();
    // what 36624fa queued for "Edit -> Increase to x3 -> Save changes" (its guard let it through)
    const edited = { ...ent('W'), qty: 3, kcal: { low: 6000, best: 6000, high: 6000 }, updated_at: new Date().toISOString() };
    await act(async () => { r.unmount(); });
    mockSaved = JSON.stringify({ ...JSON.parse(mockSaved!), entries: st.entries.map((e) => (e.id === 'W' ? edited : e)), queue: [{ kind: 'upsert', entry: edited, tries: 0 }] });
    await act(async () => { r = create(<StoreProvider><Probe /><NoticeToast /></StoreProvider>); });
    await settle();
    expect(server.log.filter((l) => l === 'PATCH /v1/entries/W')).toHaveLength(1); // refused once, never retried
    expect(server.rows.get('W')!.kcal).toBe(2000);                                  // the server kept its copy
    // the phone's row is NOT rewritten: no 0-kcal review row, no reject_code; the user's value stays and the row says so
    expect(ent('W')).toMatchObject({ kcal: { best: 6000 }, qty: 3, source: 'ai', sync_error: 'this item needs kcal (0-5000)', sync_reason: 'this item needs kcal (0-5000)' });
    expect(ent('W').needs_review).toBeFalsy(); expect(ent('W').reject_code).toBeUndefined(); expect(ent('W').review_item).toBeUndefined();
    expect(st.queue).toEqual([]);
    // the rest of the queue keeps flowing
    await act(async () => { st.addEntries([custom('Z', 120)]); });
    await settle();
    expect(server.rows.get('Z')).toMatchObject({ kcal: 120 });
    expect(ent('W').sync_error).toBeTruthy();
    // the user fixes it (x2): synced, the flag goes
    await act(async () => { st.updateEntry({ ...ent('W'), qty: 2, kcal: { low: 4000, best: 4000, high: 4000 } }); });
    await settle();
    expect(ent('W').sync_error).toBeUndefined(); expect(ent('W').sync_reason).toBeUndefined();
    expectInSync();
  });
});

describe('the delete wins: a save that gets 404 (deleted on another device) drops the local row (CEO N2)', () => {
  const noticeShown = () => r.root.findAll((n) => n.props.children === DELETED_ELSEWHERE && typeof n.type === 'string').length;
  /** after: phone == server == summary, the row is gone from the phone (not counted, not a sync-failed row), nothing retries */
  async function expectDropped(id: string) {
    expect(ent(id).deleted_at).toBeTruthy();
    expect(counted(ent(id))).toBe(false);
    expect(ent(id).sync_error).toBeUndefined(); expect(ent(id).sync_retrying).toBeUndefined();
    expectInSync();
    expect(server.rows.get(id)!.deleted).toBe(true); // never re-created
    expect(st.notice).toBe(DELETED_ELSEWHERE);
    expect(noticeShown()).toBe(1);
    const n = server.log.length;
    await tick(20); await settle();
    expect(server.log.length).toBe(n); // no retry, ever
    await act(async () => { st.dismissNotice(); });
    expect(noticeShown()).toBe(0); // shown once
  }
  test('an edit in flight when device 2 deletes the row', async () => {
    await boot();
    server.holdNext = 1;
    await act(async () => { U(480)(st); });
    await tick(4);
    expect(server.held).toHaveLength(1);
    server.remoteDelete('C');
    await act(async () => { server.held.splice(0).forEach((h) => h.release()); });
    await settle();
    expect(server.log.filter((l) => l === 'PATCH /v1/entries/C')).toHaveLength(1);
    await expectDropped('C');
    expect(dayTotals(st.entries.filter((e) => e.local_date === DAY && counted(e))).kcal).toBe(server.summary());
  });
  test('confirmReviewKcal in flight when device 2 deletes the review row', async () => {
    await boot();
    server.holdNext = 1;
    await act(async () => { K(300)(st); });
    await tick(4);
    server.remoteDelete('R');
    await act(async () => { server.held.splice(0).forEach((h) => h.release()); });
    await settle();
    await expectDropped('R');
    expect(server.summary()).toBe(server.rows.get('C')!.kcal); // R never counts
  });
  test('an edit queued while offline, then device 2 deletes the row, then back online', async () => {
    jest.useFakeTimers({ doNotFake: ['setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'queueMicrotask', 'nextTick'] });
    await boot();
    server.offline = true;
    await act(async () => { U(480)(st); });
    await settle(); await tick(6);
    expect(st.queue).toHaveLength(1); // waiting in its backoff
    expect(ent('C').kcal.best).toBe(480);
    server.remoteDelete('C');
    server.offline = false;
    jest.setSystemTime(Date.now() + 60_000); // the backoff is over
    await act(async () => { st.addEntries([custom('Z', 120)]); }); // the next sync runs the queue
    await settle();
    await expectDropped('C');
    expect(server.rows.get('Z')).toMatchObject({ kcal: 120, deleted: false });
  });
  test('a delete that gets 404 (already deleted elsewhere) is still done, without a notice', async () => {
    await boot();
    server.remoteDelete('C');
    await act(async () => { D('C')(st); });
    await settle();
    expectInSync();
    expect(st.notice).toBeNull();
  });
  test('applyFlush: a gone row drops its queued ops too (a later edit never re-creates it)', () => {
    const c = custom('C', 300);
    const later = { kind: 'upsert', entry: { ...c, kcal: { low: 500, best: 500, high: 500 } }, tries: 0 } as Op;
    const sent = [{ kind: 'upsert', entry: c, tries: 0 } as Op];
    const out = applyFlush({ entries: [c], queue: [...sent, later] }, sent, { rest: [], resolved: [], rejected: [], versions: {}, failed: [], gone: ['C'] });
    expect(out.queue).toEqual([]);
    expect(out.entries[0].deleted_at).toBeTruthy();
  });
});

describe('typed kcal after a late AI save got 409 job_abandoned (Tester item 6)', () => {
  const aiReview = (): FoodEntry => {
    const it = { ...parser.unknown('qelto'), name: 'qelto', matched_text: 'qelto', ai_estimate: true, source: 'ai_estimate', kcal: { low: 400, best: 520, high: 600 }, protein_g: { low: 1, best: 2, high: 3 } } as never;
    return { ...reviewEntry(it, { id: 'A', slot: 'lunch', raw_text: 'qelto', local_date: DAY, tableVersion: DISH_TABLE_VERSION }), job_id: 'j1' };
  };
  async function seedAi() {
    await boot();
    await act(async () => { st.addEntries([aiReview()]); });
    await settle();
    server.abandoned.add('j1'); // the backstop abandoned the job
  }
  test('exact sequence: late AI save refused -> user types 300 -> 300 everywhere', async () => {
    await seedAi();
    await act(async () => { st.confirmReview('A', ent('A').review_item!); }); // the late AI reading (an AI save tied to j1)
    await settle();
    expect(server.log).toContain('PATCH /v1/entries/A');
    expect(ent('A')).toMatchObject({ needs_review: true, ai_expired: true, kcal: { best: 0 } }); // back to the failed row
    expect(server.rows.get('A')).toMatchObject({ state: 'needs_review', kcal: 0 });
    await act(async () => { st.confirmReviewKcal('A', 300); });
    await settle();
    expect(ent('A')).toMatchObject({ source: 'custom', kcal: { best: 300 } }); expect(ent('A').job_id).toBeUndefined();
    expect(server.rows.get('A')).toMatchObject({ kcal: 300, state: 'confirmed', source: 'custom' });
    expectInSync();
  });
  test('the typed value arrives while the refused AI save is in flight: never swallowed', async () => {
    await seedAi();
    server.holdNext = 1;
    await act(async () => { st.confirmReview('A', ent('A').review_item!); });
    await tick(4);
    await act(async () => { st.confirmReviewKcal('A', 300); });
    await act(async () => { server.held.splice(0).forEach((h) => h.release()); });
    await settle();
    expect(ent('A').kcal.best).toBe(300);
    expect(server.rows.get('A')).toMatchObject({ kcal: 300, state: 'confirmed' });
    expectInSync();
  });
});

describe('1-5000 store guard (every path) and the Log Add button', () => {
  const BAD: unknown[] = ['', ' ', 0, '0', -5, '-5', NaN, 'abc', 5000.5, 5001, 6000, 99999, Infinity];
  test('validTypedKcal', () => {
    for (const k of BAD) expect([k, validTypedKcal(k)]).toEqual([k, false]);
    for (const k of [1, '1', 250, '5000', 5000]) expect([k, validTypedKcal(k)]).toEqual([k, true]);
    expect(savableEntry(custom('x', 6000))).toBe(false); expect(savableEntry(custom('x', 0))).toBe(false); expect(savableEntry(custom('x', 5000))).toBe(true);
  });
  test('confirmReviewKcal, addEntries and updateEntry refuse every bad value; nothing counted or sent', async () => {
    await boot();
    const before = JSON.stringify(st.entries);
    for (const k of BAD) {
      await act(async () => { st.confirmReviewKcal('R', k as number); st.addEntries([custom(`n${String(k)}`, k as number)]); U(k as number)(st); });
    }
    expect(JSON.stringify(st.entries)).toBe(before);
    expect(st.queue).toEqual([]);
    await act(async () => { st.confirmReviewKcal('R', 5000); st.addEntries([custom('ok1', 1)]); });
    await settle();
    expect(ent('R').kcal.best).toBe(5000); expect(ent('ok1').kcal.best).toBe(1);
    expectInSync();
  });
  test('Log failed row: Add disabled for empty, 0, negative, 5001, 6000, 99999; enabled for 1 and 5000', async () => {
    for (const [v, ok] of [['', false], ['0', false], ['-5', false], ['5001', false], ['6000', false], ['99999', false], ['abc', false], ['1', true], ['5000', true]] as const) {
      const onAdd = jest.fn();
      let rr!: ReactTestRenderer;
      await act(async () => { rr = create(<FailedAiRow row={{ name: 'zorbu', kcal: v, added: false, reason: 'daily_limit' }} onKcal={() => {}} onAdd={onAdd} />); });
      const btn = rr.root.findAll((n) => n.props.accessibilityLabel === 'Add zorbu' && typeof n.props.onPress === 'function')[0];
      expect([v, !!btn.props.disabled]).toEqual([v, !ok]);
      await act(async () => { btn.props.onPress(); }); // a forced press while disabled does nothing
      expect([v, onAdd.mock.calls.length]).toEqual([v, ok ? 1 : 0]);
      expect(rr.root.findAllByType(TextInput)).toHaveLength(1);
      await act(async () => { rr.unmount(); });
    }
  });
  test('an added failed row with 6000 does not count', async () => {
    expect(failedCounts({ key: 'k', id: 'i', name: 'n', kcal: '6000', protein: '', added: true } as never)).toBe(false);
    expect(failedCounts({ key: 'k', id: 'i', name: 'n', kcal: '5000', protein: '', added: true } as never)).toBe(true);
  });
});
