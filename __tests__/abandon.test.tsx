// Abandon (backend 4022019): the 35-minute backstop tells the server to stop trying a job and to ignore its late result.
// Online it is sent at once; offline it waits in the sync queue. An AI reading tied to an abandoned job is refused (409
// job_abandoned) and goes back to the failed row, so only the user's typed kcal is ever saved and counted.
import React from 'react';
import { act, create } from 'react-test-renderer';

jest.mock('../src/lib/config', () => ({ config: { mock: false, apiUrl: 'http://api.test', mockAi: false }, flags: {} }));
let mockSaved: string | null = null;
jest.mock('../src/lib/kv', () => ({ kv: { get: async () => mockSaved, set: async (_k: string, v: string) => { mockSaved = v; } } }));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'uuid' }));

import { ApiError, createApi } from '../src/lib/api';
import { abandonedEntry, AI_BACKSTOP_MS, expirePending } from '../src/lib/aiBackstop';
import { entryFromItem, FoodEntry, pendingEntry, toReview } from '../src/lib/domain';
import { resolvePending } from '../src/lib/pending';
import { enqueue, flush, Op, PendingFood, Sender } from '../src/lib/syncQueue';
import { parser, DISH_TABLE_VERSION } from '../src/parser';

const MIN = 60_000;
const NOW = Date.parse('2026-10-17T04:00:00Z');
const food = (job?: string, minAgo = 36): PendingFood => ({ id: 'p1', span: 'kombucha', slot: 'lunch', local_date: '2026-10-17', raw_text: 'kombucha', at: 0,
  queued_at: NOW - minAgo * MIN, ...(job ? { job_id: job } : {}) });
const aiItem = { ...parser.unknown('kombucha'), name: 'kombucha', matched_text: 'kombucha', ai_estimate: true, source: 'ai_estimate', needs_confirmation: false,
  kcal: { low: 40, best: 60, high: 80 }, protein_g: { low: 0, best: 0, high: 0 } } as unknown as Parameters<typeof entryFromItem>[0];
const aiEntry = (job = 'j1'): FoodEntry => ({ ...entryFromItem(aiItem, { id: 'p1', slot: 'lunch', raw_text: 'kombucha', local_date: '2026-10-17', tableVersion: DISH_TABLE_VERSION }), job_id: job });
const sender = (over: Partial<Sender> = {}): Sender => ({ upsertEntry: jest.fn(async () => {}), deleteEntry: jest.fn(async () => {}), resolvePending: jest.fn(async () => null),
  deleteRemembered: jest.fn(async () => {}), abandonJob: jest.fn(async () => {}), ...over });
const reply = (status: number, body: unknown = {}) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const fetchMock = jest.fn();
beforeEach(() => { fetchMock.mockReset(); (global as unknown as { fetch: unknown }).fetch = fetchMock; });

describe('backstop conversion queues abandon', () => {
  test('a queued food with a server job: converted row + abandon op for that job', () => {
    const f = food('j1'); const ph = pendingEntry(f, new Date(f.queued_at!));
    const r = expirePending([ph], [{ kind: 'pending', food: f, tries: 0 }], NOW);
    expect(r.converted).toEqual(['p1']);
    expect(r.queue.map((o) => o.kind)).toEqual(['upsert', 'abandon']);
    expect(r.queue[1]).toMatchObject({ kind: 'abandon', id: 'j1' });
    expect(r.entries[0]).toMatchObject({ ai_expired: true, needs_review: true, kcal: { best: 0 } });
  });
  test('no job yet (never reached the server): nothing to abandon', () => {
    const f = food(); const r = expirePending([pendingEntry(f, new Date(f.queued_at!))], [{ kind: 'pending', food: f, tries: 0 }], NOW);
    expect(r.queue.some((o) => o.kind === 'abandon')).toBe(false);
  });
  test('before the cutoff, or already resolved: no abandon', () => {
    const f = food('j1', 34);
    expect(expirePending([pendingEntry(f)], [{ kind: 'pending', food: f, tries: 0 }], NOW).queue.some((o) => o.kind === 'abandon')).toBe(false);
    const g = food('j1'); const done = { ...pendingEntry(g), pending: false };
    expect(expirePending([done], [{ kind: 'pending', food: g, tries: 0 }], NOW).queue.some((o) => o.kind === 'abandon')).toBe(false);
    expect(AI_BACKSTOP_MS).toBe(35 * MIN);
  });
  test('the same job is abandoned once (coalesced)', () => {
    const q = enqueue(enqueue([], { kind: 'abandon', id: 'j1', tries: 0 }), { kind: 'abandon', id: 'j1', tries: 0 });
    expect(q).toHaveLength(1);
  });
});

describe('flush: online sends, offline keeps it queued', () => {
  const q: Op[] = [{ kind: 'abandon', id: 'j1', tries: 0 }];
  test('online: POST abandon, op done', async () => {
    const s = sender();
    const r = await flush(q, s, NOW);
    expect(s.abandonJob).toHaveBeenCalledWith('j1'); expect(r.rest).toEqual([]);
  });
  test('offline: stays at the head with a backoff, sent once back online', async () => {
    const s = sender({ abandonJob: jest.fn(async () => { throw new TypeError('Network request failed'); }) });
    const r = await flush(q, s, NOW);
    expect(r.rest).toHaveLength(1); expect(r.rest[0]).toMatchObject({ kind: 'abandon', id: 'j1', tries: 1, nextAt: NOW + 5_000 });
    const s2 = sender();
    expect((await flush(r.rest, s2, NOW + 5_000)).rest).toEqual([]);
    expect(s2.abandonJob).toHaveBeenCalledWith('j1');
  });
  test('409 job_abandoned on an AI save: refused for good (not retried), handed back with its code', async () => {
    const s = sender({ upsertEntry: jest.fn(async () => { throw new ApiError(409, JSON.stringify({ error: { code: 'job_abandoned', item: 0, job_id: 'j1' } })); }) });
    const e = aiEntry();
    const r = await flush([{ kind: 'upsert', entry: e, tries: 0 }], s, NOW);
    expect(r.rest).toEqual([]);
    expect(r.rejected).toEqual([{ entry: e, code: 'job_abandoned' }]);
  });
  test('other 409s never block the queue: surfaced on the entry', async () => {
    const s = sender({ upsertEntry: jest.fn(async () => { throw new ApiError(409, JSON.stringify({ error: 'entry changed on the server' })); }) });
    const r = await flush([{ kind: 'upsert', entry: aiEntry(), tries: 0 }, { kind: 'abandon', id: 'j2', tries: 0 }], s, NOW);
    expect(r.rest).toEqual([]); expect(r.failed).toEqual([{ id: 'p1', code: 'entry changed on the server', sent: expect.objectContaining({ id: 'p1' }) }]);
    expect(s.abandonJob).toHaveBeenCalledWith('j2'); // the later op still went out
  });
  test('the refused AI reading becomes the failed row again: no number, typed kcal only', () => {
    const e = abandonedEntry(aiEntry(), new Date(NOW));
    expect(e).toMatchObject({ id: 'p1', ai_expired: true, needs_review: true, kcal: { low: 0, best: 0, high: 0 } });
    expect(e.job_id).toBeUndefined(); expect(toReview(e)).toBe(true);
  });
});

describe('api', () => {
  const api = createApi(() => 'tok');
  test('abandonJob: POST /v1/parse/jobs/{id}/abandon', async () => {
    fetchMock.mockResolvedValue(reply(200, { job_id: 'j 1', status: 'abandoned' }));
    await api.abandonJob('j 1');
    expect(fetchMock).toHaveBeenCalledWith('http://api.test/v1/parse/jobs/j%201/abandon', expect.objectContaining({ method: 'POST' }));
  });
  test('404 / 410 = done; other errors are retried by the queue', async () => {
    fetchMock.mockResolvedValue(reply(404, { error: 'no such job' })); await expect(api.abandonJob('j1')).resolves.toBeUndefined();
    fetchMock.mockResolvedValue(reply(410)); await expect(api.abandonJob('j1')).resolves.toBeUndefined();
    fetchMock.mockResolvedValue(reply(503)); await expect(api.abandonJob('j1')).rejects.toBeInstanceOf(ApiError);
  });
  test('AI save sends parse_job_id; its PATCH says source ai_estimate', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { duplicates: [{}] })).mockResolvedValueOnce(reply(200, {}));
    await api.upsertEntry(aiEntry());
    const post = JSON.parse(fetchMock.mock.calls[0][1].body), patch = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(post.items[0]).toMatchObject({ source: 'ai_estimate', parse_job_id: 'j1' });
    expect(patch).toMatchObject({ source: 'ai_estimate', parse_job_id: 'j1' });
  });
  test('typed kcal on the same row: source custom without the job (no AI provenance), never ai_estimate', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { duplicates: [{}] })).mockResolvedValueOnce(reply(200, {}));
    await api.upsertEntry({ ...aiEntry(), source: 'custom', custom_name: 'kombucha', kcal: { low: 90, best: 90, high: 90 } });
    const post = JSON.parse(fetchMock.mock.calls[0][1].body).items[0], patch1 = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(post).toMatchObject({ source: 'custom', kcal: 90 }); expect(post.parse_job_id).toBeUndefined();
    expect(patch1.source).toBeUndefined(); expect(patch1.parse_job_id).toBeUndefined(); expect(patch1.if_unmodified_since).toBeUndefined();
    fetchMock.mockClear().mockResolvedValueOnce(reply(200, { duplicates: [{}] })).mockResolvedValueOnce(reply(200, {}));
    await api.upsertEntry({ ...aiEntry(), job_id: undefined });
    const patch = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(patch.source).toBeUndefined(); expect(patch.parse_job_id).toBeUndefined();
  });
  test('entries resolved from a job carry its id', async () => {
    const es = await resolvePending({ parse: jest.fn(), parseJob: jest.fn(async () => ({ items: [aiItem], unmatched: [], custom_items: [], ai_state: 'answered' })) } as never, food('j9'));
    expect(Array.isArray(es) && es[0].job_id).toBe('j9');
  });
});

// the real store: backstop conversion -> abandon sent when online, queued while offline
import { StoreProvider, Store, useStore } from '../src/lib/store';
let st!: Store;
function Probe() { st = useStore(); return null; }
const flushAll = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
function seed(f: PendingFood) {
  const ph = pendingEntry(f, new Date(f.queued_at!));
  mockSaved = JSON.stringify({ user: { id: 'u', name: 'A', email: 'a@x', idToken: 't', mock: false }, profile: null, entries: [ph], steps: {},
    queue: [{ kind: 'pending', food: f, tries: 0 }], themePref: 'system', challenge: null, aiQuota: { used: 0 }, learned: {} });
}
const calls = (path: RegExp) => fetchMock.mock.calls.filter((c) => path.test(String(c[0])));
describe('store', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(NOW); });
  afterEach(() => { jest.useRealTimers(); });
  test('online: the conversion abandons the job at once; the row is the failed row', async () => {
    fetchMock.mockImplementation(async (url: string) => reply(200, /remembered/.test(url) ? { remembered: [] } : /abandon/.test(url) ? { status: 'abandoned' } : {}));
    seed(food('j1'));
    let r!: ReturnType<typeof create>;
    await act(async () => { r = create(<StoreProvider><Probe /></StoreProvider>); });
    await flushAll();
    expect(calls(/\/v1\/parse\/jobs\/j1\/abandon$/)).toHaveLength(1);
    expect(calls(/\/v1\/parse\/jobs\/j1$/)).toHaveLength(0); // never polled again
    expect(st.queue).toEqual([]);
    expect(st.entries[0]).toMatchObject({ id: 'p1', ai_expired: true, kcal: { best: 0 } });
    await act(async () => { r.unmount(); });
  });
  test('offline: abandon stays queued and goes out when the network is back', async () => {
    let online = false;
    fetchMock.mockImplementation(async (url: string) => { if (!online) throw new TypeError('Network request failed'); return reply(200, /remembered/.test(url) ? { remembered: [] } : {}); });
    seed(food('j1'));
    let r!: ReturnType<typeof create>;
    await act(async () => { r = create(<StoreProvider><Probe /></StoreProvider>); });
    await flushAll();
    expect(st.queue.map((o) => o.kind)).toEqual(['upsert', 'abandon']);
    online = true;
    await act(async () => { jest.advanceTimersByTime(6_000); }); await flushAll();
    await act(async () => { jest.advanceTimersByTime(6_000); }); await flushAll();
    expect(calls(/\/abandon$/).length).toBeGreaterThanOrEqual(1);
    expect(st.queue).toEqual([]);
    await act(async () => { r.unmount(); });
  });
  test('st.abandonJob (Log screen) queues one op and sends it', async () => {
    fetchMock.mockImplementation(async (url: string) => reply(200, /remembered/.test(url) ? { remembered: [] } : {}));
    mockSaved = JSON.stringify({ user: { id: 'u', name: 'A', email: 'a@x', idToken: 't', mock: false }, entries: [], queue: [], aiQuota: { used: 0 } });
    let r!: ReturnType<typeof create>;
    await act(async () => { r = create(<StoreProvider><Probe /></StoreProvider>); });
    await flushAll();
    await act(async () => { st.abandonJob('job7'); st.abandonJob('job7'); });
    await flushAll();
    expect(calls(/\/v1\/parse\/jobs\/job7\/abandon$/)).toHaveLength(1);
    expect(st.queue).toEqual([]);
    await act(async () => { r.unmount(); });
  });
  test('a refused AI save (job_abandoned) goes back to the failed row; typed kcal then saves as custom', async () => {
    fetchMock.mockImplementation(async (url: string, init: { method: string; body?: string }) => {
      if (/remembered/.test(url)) return reply(200, { remembered: [] });
      if (init.method === 'POST' && /\/v1\/entries$/.test(url) && JSON.parse(init.body!).items[0].source === 'ai_estimate') return reply(409, { error: { code: 'job_abandoned', item: 0, job_id: 'j1' } });
      return reply(200, {});
    });
    mockSaved = JSON.stringify({ user: { id: 'u', name: 'A', email: 'a@x', idToken: 't', mock: false }, entries: [], queue: [], aiQuota: { used: 0 } });
    let r!: ReturnType<typeof create>;
    await act(async () => { r = create(<StoreProvider><Probe /></StoreProvider>); });
    await flushAll();
    await act(async () => { st.addEntries([aiEntry()]); });
    await flushAll();
    expect(st.entries[0]).toMatchObject({ id: 'p1', ai_expired: true, needs_review: true, kcal: { best: 0 } });
    await act(async () => { st.confirmReviewKcal('p1', 90); });
    await flushAll();
    expect(st.entries[0]).toMatchObject({ source: 'custom', kcal: { best: 90 }, needs_review: false });
    const last = calls(/\/v1\/entries$/).pop()!;
    expect(JSON.parse(last[1].body).items[0]).toMatchObject({ source: 'custom', kcal: 90 });
    expect(st.queue).toEqual([]);
    await act(async () => { r.unmount(); });
  });
});
