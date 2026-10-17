// 35-minute AI backstop in the real store: conversion on start, the confirmReview guard, and a late sync result ignored.
import React from 'react';
import { act, create } from 'react-test-renderer';

let mockSaved: string | null = null;
jest.mock('../src/lib/kv', () => ({ kv: { get: async () => mockSaved, set: async (_k: string, v: string) => { mockSaved = v; } } }));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'uuid' }));
type Deferred = { resolve: (v: unknown) => void };
const mockJobs: Deferred[] = [];
const mockApi = {
  mock: false,
  parse: jest.fn(() => new Promise((resolve) => { mockJobs.push({ resolve }); })),
  parseJob: jest.fn(), upsertEntry: jest.fn(async () => {}), deleteEntry: jest.fn(async () => {}), deleteRemembered: jest.fn(async () => {}),
  getRemembered: jest.fn(async () => []), putProfile: jest.fn(async () => {}), deleteMe: jest.fn(async () => {}),
};
jest.mock('../src/lib/api', () => ({ ...jest.requireActual('../src/lib/api'), createApi: () => mockApi }));

import { StoreProvider, Store, useStore } from '../src/lib/store';
import { pendingEntry, toReview } from '../src/lib/domain';
import { PendingFood } from '../src/lib/syncQueue';
import { parser } from '../src/parser';

const MIN = 60_000;
const NOW = Date.parse('2026-10-17T04:00:00Z');
let st!: Store;
function Probe() { st = useStore(); return null; }
const food = (startedMinAgo: number): PendingFood => ({ id: 'p1', span: 'dum aloo lakhnavi', slot: 'lunch', local_date: '2026-10-17', raw_text: 'dum aloo lakhnavi', at: 0, queued_at: NOW - startedMinAgo * MIN });
function seed(f: PendingFood, user = true) {
  const ph = pendingEntry(f, new Date(f.queued_at!));
  mockSaved = JSON.stringify({ user: user ? { id: 'u', name: 'A', email: 'a@x', idToken: 't', mock: false } : null, profile: null, entries: [ph], steps: {},
    queue: [{ kind: 'upsert', entry: ph, tries: 0 }, { kind: 'pending', food: f, tries: 0 }], themePref: 'system', challenge: null, aiUsed: {}, learned: {} });
}
const flushAll = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };
const ai = { ...parser.unknown('dum aloo lakhnavi'), name: 'dum aloo lakhnavi', matched_text: 'dum aloo lakhnavi', ai_estimate: true, source: 'ai_estimate', needs_confirmation: true,
  kcal: { low: 220, best: 260, high: 300 }, protein_g: { low: 4, best: 5, high: 6 } };

beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(NOW); mockJobs.length = 0; mockApi.parse.mockClear(); });
afterEach(() => { jest.useRealTimers(); });

test('app start: a food queued 36 min ago is a failed AI row; the store guard refuses it without real kcal', async () => {
  seed(food(36), false);
  let r!: ReturnType<typeof create>;
  await act(async () => { r = create(<StoreProvider><Probe /></StoreProvider>); });
  await flushAll();
  const e = st.entries.find((x) => x.id === 'p1')!;
  expect(e.ai_expired).toBe(true); expect(e.pending).toBe(false); expect(toReview(e)).toBe(true);
  expect(st.queue.some((o) => o.kind === 'pending')).toBe(false);
  await act(async () => { st.confirmReview('p1', e.review_item!); });                                                  // placeholder as is
  await act(async () => { st.confirmReview('p1', { ...e.review_item!, kcal: { low: 0, best: 0, high: 0 } }); });     // 0 kcal
  expect(st.entries.find((x) => x.id === 'p1')).toEqual(e);
  await act(async () => { st.confirmReviewKcal('p1', 0); });
  expect(st.entries.find((x) => x.id === 'p1')).toEqual(e);
  await act(async () => { st.confirmReviewKcal('p1', 280); });                                                        // typed kcal: the only way in
  const n = st.entries.find((x) => x.id === 'p1')!;
  expect(n.kcal.best).toBe(280); expect(n.needs_review).toBe(false); expect(n.source).toBe('custom');
  await act(async () => { r.unmount(); });
});

test('app start at 34 min: still pending (not converted)', async () => {
  seed(food(34), false);
  let r!: ReturnType<typeof create>;
  await act(async () => { r = create(<StoreProvider><Probe /></StoreProvider>); });
  await flushAll();
  expect(st.entries.find((x) => x.id === 'p1')!.pending).toBe(true);
  expect(st.queue.some((o) => o.kind === 'pending')).toBe(true);
  await act(async () => { r.unmount(); });
});

test('late server result after conversion (sync in flight) never overwrites the row the user filled', async () => {
  seed(food(34));
  let r!: ReturnType<typeof create>;
  await act(async () => { r = create(<StoreProvider><Probe /></StoreProvider>); });
  await flushAll();
  expect(mockApi.parse).toHaveBeenCalledTimes(1); // the sync is polling this food
  await act(async () => { jest.setSystemTime(NOW + 2 * MIN); st.expireAi(); });  // now 36 min: converted
  expect(st.entries.find((x) => x.id === 'p1')!.ai_expired).toBe(true);
  await act(async () => { st.confirmReviewKcal('p1', 280); });                    // user types their kcal
  await act(async () => { mockJobs[0].resolve({ items: [ai], unmatched: [], custom_items: [], ai_state: 'answered', fallback: 'used' }); });
  await flushAll();
  const rows = st.entries.filter((x) => x.id === 'p1' || x.id.startsWith('p1-'));
  expect(rows).toHaveLength(1);
  expect(rows[0].kcal.best).toBe(280); expect(rows[0].source).toBe('custom');
  expect(st.queue.some((o) => o.kind === 'pending' || (o.kind === 'upsert' && o.entry.kcal.best === 260))).toBe(false);
  expect(st.queue.some((o) => o.kind === 'upsert' && o.entry.id === 'p1' && o.entry.kcal.best === 280) || mockApi.upsertEntry.mock.calls.some((c) => (c as unknown[])[0] && ((c as unknown[])[0] as { kcal: { best: number } }).kcal.best === 280)).toBe(true);
  await act(async () => { r.unmount(); });
});
