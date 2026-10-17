// Daily AI cap ran out (Product, Oct 17): the failed row says plainly "Today’s free estimates are used up. Add the calories
// yourself, or try again tomorrow." Same failed / no-kcal path; never a bare 'failed' message.
import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { TextInput } from 'react-native';

const mockStore = {
  learned: {}, aiQuota: { used: 0 } as { used: number; resetAt?: string }, entries: [] as unknown[], queue: [] as unknown[],
  api: { mock: true, parse: jest.fn(), parseJob: jest.fn() },
  newId: (() => { let n = 0; return () => `id${n++}`; })(),
  useAi: jest.fn(), fillPending: jest.fn(), addPending: jest.fn(), addEntries: jest.fn(), remember: jest.fn(), expireAi: jest.fn(),
  confirmReview: jest.fn(), confirmReviewKcal: jest.fn(), dropReview: jest.fn(),
};
jest.mock('@/lib/store', () => ({ useStore: () => mockStore }));
jest.mock('@/lib/config', () => ({ config: { mock: true, mockAi: true, mockAiDelay: 0 }, flags: {} }));
jest.mock('expo-router', () => {
  const R = jest.requireActual('react');
  return {
    useFocusEffect: (cb: () => (() => void) | void) => R.useEffect(() => cb(), []),
    useRouter: () => ({ navigate: jest.fn(), push: jest.fn(), back: jest.fn() }),
    useLocalSearchParams: () => ({}),
  };
});
jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual('react-native');
  return { SafeAreaView: View, SafeAreaProvider: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});

import Log from '../src/app/(tabs)/log';
import Review from '../src/app/review';
import { capCopy, CAP_REASONS, failedCopy, failReason, FAILED_COPY, leaveLog } from '../src/lib/aiRows';
import { bulkEligible, canConfirm, reviewBulk, reviewRowKind } from '../src/lib/confirmBatch';
import { counted, dayTotals, hasKcal, pendingEntry, toReview } from '../src/lib/domain';
import { resolvePending } from '../src/lib/pending';
import { enqueue, flush, PendingFood } from '../src/lib/syncQueue';

const mockConfig = (jest.requireMock('@/lib/config') as { config: { mockAi: boolean } }).config;
// the server's next_reset_at (midnight PDT = 12:30 PM IST) and a clock at 8:30 AM IST the same day
const RESET = '2026-10-18T00:00:00-07:00';
const NOW = Date.parse('2026-10-18T03:00:00Z');
const CAP = capCopy(RESET, new Date(NOW)); // in the device's time zone
const LATER = 'Today’s free estimates are used up. Add the calories yourself, or try again later.';
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(NOW); });
afterEach(() => { jest.useRealTimers(); });
const capBody = (o: object) => ({ items: [], unmatched: ['kombucha'], custom_items: [], ai_state: 'failed', next_reset_at: RESET, ...o });
const texts = (r: ReactTestRenderer) => r.root.findAll((n) => typeof n.props.children === 'string').map((n) => n.props.children as string);

describe('cap copy', () => {
  test('exact text (IST device)', () => {
    expect(capCopy(RESET, new Date(NOW), 'Asia/Kolkata')).toBe('Today’s free estimates are used up. Add the calories yourself, or try again after 12:30 PM.');
    expect(CAP).toMatch(/^Today’s free estimates are used up\. Add the calories yourself, or try again (tomorrow )?after \d{1,2}:\d{2} (AM|PM)\.$/);
  });
  test.each(CAP_REASONS)('%s -> cap copy (with or without number / reset time)', (r) => {
    expect(failedCopy({ reason: r })).toBe(LATER); // reset unknown
    expect(failedCopy({ reason: r, userDailyLimit: 3, resetsAt: RESET })).toBe(CAP);
  });
  test('a cap fallback with no fallback_reason still gets the cap copy (not the generic one)', () => {
    for (const fb of ['cap_reached', 'global_cap_reached', 'daily_limit']) expect(failedCopy({ reason: failReason({ fallback: fb }), resetsAt: RESET })).toBe(CAP);
    expect(failReason({ fallback: 'cap_reached', fallback_reason: 'user_limit' })).toBe('user_limit');
    expect(failReason({ fallback: 'error' })).toBe('error');
  });
  test('non-cap failures keep the generic copy; no copy is ever a bare "failed"', () => {
    for (const r of [undefined, 'error', 'gave_up', 'bad_request', 'backstop']) expect(failedCopy({ reason: r })).toBe(FAILED_COPY);
    for (const r of [...CAP_REASONS, undefined, 'error']) expect(failedCopy({ reason: r })).toMatch(/Add the calories yourself/);
    for (const r of [...CAP_REASONS, undefined, 'error']) expect(failedCopy({ reason: r }).toLowerCase()).not.toMatch(/\bfailed\b/);
  });
});

describe('Log: cap failures show the cap copy on the failed / no-kcal row', () => {
  beforeEach(() => { mockStore.addEntries.mockClear(); mockStore.aiQuota = { used: 0 }; mockConfig.mockAi = true; });
  async function type(t: string) {
    let r!: ReactTestRenderer;
    await act(async () => { r = create(<Log />); });
    const input = r.root.findAll((n) => n.type === TextInput && n.props.accessibilityLabel === 'What did you eat?')[0];
    await act(async () => { input.props.onChangeText(t); });
    await act(async () => { jest.advanceTimersByTime(700); });
    await act(async () => { await Promise.resolve(); });
    return r;
  }
  test.each([
    ['user_limit', { fallback: 'cap_reached', fallback_reason: 'user_limit', user_daily_limit: 3 }],
    ['daily_limit (older server: ai_resets_at only)', { fallback: 'daily_limit', fallback_reason: 'daily_limit', next_reset_at: undefined, ai_resets_at: RESET }],
    ['global_cap_reached, no reason', { fallback: 'global_cap_reached' }],
    ['cap_reached, no reason', { fallback: 'cap_reached' }],
  ])('server %s', async (_n, o) => {
    mockStore.api.parse.mockReset().mockResolvedValue(capBody(o));
    const r = await type('kombucha');
    const t = texts(r);
    expect(t).toContain(CAP);
    expect(t).not.toContain(FAILED_COPY);
    expect(t).toContain('not counted'); // no kcal until typed
    const add = r.root.findAll((n) => n.props.accessibilityLabel === 'Add kombucha' && n.props.accessibilityState)[0];
    expect(add.props.disabled).toBe(true); // needs typed kcal
    await act(async () => { r.unmount(); });
  });
  test('the app’s own per-user cap (offline of the server) shows the same copy', async () => {
    mockConfig.mockAi = false; mockStore.api.mock = false;
    mockStore.aiQuota = { used: 3, resetAt: RESET };
    mockStore.api.parse.mockReset().mockResolvedValue(capBody({ fallback: 'cap_reached', fallback_reason: 'user_limit' }));
    const r = await type('kombucha');
    expect(texts(r)).toContain(CAP);
    expect(mockStore.api.parse).not.toHaveBeenCalled();
    await act(async () => { r.unmount(); });
    mockStore.api.mock = true;
  });
  test.each([
    ['after the server’s reset instant', { used: 3, resetAt: '2026-10-18T02:59:00Z' }],
    ['reset unknown (the server decides)', { used: 3 }],
  ])('the app’s own cap does not block %s', async (_n, q) => {
    mockConfig.mockAi = false; mockStore.api.mock = false;
    mockStore.aiQuota = q;
    mockStore.api.parse.mockReset().mockResolvedValue(capBody({ fallback: 'used', ai_state: 'answered', items: [] }));
    const r = await type('kombucha');
    expect(mockStore.api.parse).toHaveBeenCalled();
    await act(async () => { r.unmount(); });
    mockStore.api.mock = true;
  });
});

describe('queued food: the cap ends it as a failed row with the cap copy', () => {
  const f: PendingFood = { id: 'p1', span: 'kombucha', slot: 'snacks', local_date: '2026-10-17', raw_text: 'kombucha', at: 0, queued_at: 1 };
  test('resolvePending returns the failed row (typed kcal only, never bulk, guard refuses, never 0)', async () => {
    const es = await resolvePending({ parse: async () => capBody({ fallback: 'cap_reached', fallback_reason: 'user_limit' }) as never }, f);
    expect(Array.isArray(es)).toBe(true);
    const e = (es as ReturnType<typeof pendingEntry>[])[0];
    expect(e.id).toBe('p1'); expect(e.ai_fail_reason).toBe('user_limit'); expect(e.ai_resets_at).toBe(RESET); expect(failedCopy({ reason: e.ai_fail_reason, resetsAt: e.ai_resets_at })).toBe(CAP);
    expect(toReview(e)).toBe(true); expect(counted(e)).toBe(false); expect(dayTotals([e]).kcal).toBe(0);
    expect(reviewRowKind(e.review_item!)).toBe('kcal');
    expect(bulkEligible({ ...e.review_item!, one_tap_ok: true })).toBe(false); expect(reviewBulk([e])).toEqual([]);
    expect(hasKcal(e.review_item) && canConfirm(e.review_item!)).toBe(false);
  });
  test('global cap with no reason, via the sync queue: pending op gone, failed row synced', async () => {
    const ph = pendingEntry(f);
    const q = enqueue(enqueue([], { kind: 'upsert', entry: ph, tries: 0 }), { kind: 'pending', food: f, tries: 0 });
    const { rest, resolved } = await flush(q, { upsertEntry: async () => {}, deleteEntry: async () => {}, deleteRemembered: async () => {},
      resolvePending: (x) => resolvePending({ parse: async () => capBody({ fallback: 'global_cap_reached' }) as never }, x) }, 0);
    expect(resolved).toHaveLength(1); expect(resolved[0].ai_fail_reason).toBe('global_cap_reached');
    expect(rest).toEqual([]);
  });
  test.each(['gave_up', 'error'])('a final non-cap failure (%s, backend 22a6a18) is the failed row now, not Estimating until the backstop', async (reason) => {
    const es = await resolvePending({ parse: async () => capBody({ fallback: reason, fallback_reason: reason }) as never }, f) as ReturnType<typeof pendingEntry>[];
    expect(es).toHaveLength(1);
    const e = es[0];
    expect(e).toMatchObject({ id: 'p1', ai_fail_reason: reason, needs_review: true, pending: false }); expect(e.ai_expired).toBeUndefined();
    expect(failedCopy({ reason: e.ai_fail_reason })).toBe(FAILED_COPY);
    expect(counted(e)).toBe(false); expect(dayTotals([e]).kcal).toBe(0); expect(e.kcal.best).toBe(0); expect(hasKcal(e.review_item)).toBe(false);
    expect(reviewRowKind(e.review_item!)).toBe('kcal');
  });
  test('gave_up on the job poll via the sync queue: pending op gone, failed row synced, the job abandoned (as the backstop does)', async () => {
    const fj = { ...f, job_id: 'job-7' };
    const sent: string[] = [];
    const q = enqueue(enqueue([], { kind: 'upsert', entry: pendingEntry(fj), tries: 0 }), { kind: 'pending', food: fj, tries: 0 });
    const { rest, resolved } = await flush(q, { upsertEntry: async (e) => { sent.push(`upsert ${e.id} ${e.ai_fail_reason ?? ''}`); }, deleteEntry: async () => {}, deleteRemembered: async () => {},
      abandonJob: async (id) => { sent.push(`abandon ${id}`); },
      resolvePending: (x) => resolvePending({ parse: async () => { throw new Error('no'); }, parseJob: async () => ({ ...capBody({ fallback: 'gave_up', fallback_reason: 'gave_up' }), attempts: 3, max_attempts: 3 }) as never }, x) }, 0);
    expect(resolved.map((e) => e.ai_fail_reason)).toEqual(['gave_up']);
    expect(rest).toEqual([]);
    expect(sent).toEqual(['upsert p1 ', 'upsert p1 gave_up', 'abandon job-7']);
  });
  test('busy / still estimating (rate_limited, timeout) stays pending: only no answer at all is left to the 35-minute backstop', async () => {
    for (const reason of ['rate_limited', 'timeout', 'unavailable'])
      expect(await resolvePending({ parse: async () => ({ ...capBody({ fallback: 'busy', fallback_reason: reason }), ai_state: 'estimating' }) as never }, f)).toBeNull();
  });
  test('leaving Log keeps the cap reason on the review row', () => {
    const { reviews } = leaveLog({ open: [], failed: [{ key: 'k', id: 'f1', name: 'kombucha', kcal: '', protein: '', added: false, reason: 'daily_limit', resetsAt: RESET }],
      estimating: [], slot: 'snacks', text: 'kombucha', date: '2026-10-17', newId: () => 'x' });
    expect(reviews[0].ai_fail_reason).toBe('daily_limit');
    expect(failedCopy({ reason: reviews[0].ai_fail_reason, resetsAt: reviews[0].ai_resets_at })).toBe(CAP);
  });
});

test('Review shows the cap copy on the kcal row', async () => {
  const f: PendingFood = { id: 'p1', span: 'kombucha', slot: 'snacks', local_date: '2026-10-17', raw_text: 'kombucha', at: 0, queued_at: 1 };
  const es = await resolvePending({ parse: async () => capBody({ fallback: 'daily_limit', fallback_reason: 'daily_limit' }) as never }, f);
  mockStore.entries = es as unknown[]; mockStore.queue = [];
  let r!: ReactTestRenderer;
  await act(async () => { r = create(<Review />); });
  const t = texts(r);
  expect(t).toContain(CAP); expect(t).toContain('Enter kcal');
  expect(t.some((x) => x.startsWith('✓ All look right'))).toBe(false);
  await act(async () => { r.unmount(); });
  mockStore.entries = [];
});
