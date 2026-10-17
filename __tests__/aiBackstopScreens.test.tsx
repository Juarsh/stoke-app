// 35-minute AI backstop on the real Log screen and the real store (timers faked; the clock is jumped).
import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { TextInput } from 'react-native';
import { ParsePending } from '../src/lib/api';

type Deferred = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
const jobs: Deferred[] = [];
const mockStore = {
  learned: {}, aiQuota: { used: 0 }, entries: [], queue: [],
  api: { mock: true, parse: jest.fn(), parseJob: jest.fn() },
  newId: (() => { let n = 0; return () => `id${n++}`; })(),
  useAi: jest.fn(), fillPending: jest.fn(), addPending: jest.fn(), addEntries: jest.fn(), remember: jest.fn(), expireAi: jest.fn(),
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
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});

import Log from '../src/app/(tabs)/log';
import { parser } from '../src/parser';

const MIN = 60_000;
const COPY = 'Couldn’t estimate this. Add the calories yourself.';
const texts = (r: ReactTestRenderer) => r.root.findAll((n) => typeof n.props.children === 'string').map((n) => n.props.children as string);
const has = (r: ReactTestRenderer, s: string) => texts(r).some((t) => t.includes(s));
const answer = { items: [{ ...parser.unknown('kombucha'), name: 'kombucha', matched_text: 'kombucha', ai_estimate: true, source: 'ai_estimate', needs_confirmation: true,
  kcal: { low: 40, best: 60, high: 80 }, protein_g: { low: 0, best: 0, high: 0 } }], unmatched: [], custom_items: [], ai_state: 'answered', fallback: 'used' };

async function startEstimating() {
  jobs.length = 0;
  mockStore.api.parse.mockReset().mockRejectedValue(new ParsePending('job1'));
  mockStore.api.parseJob.mockReset().mockImplementation(() => new Promise((resolve, reject) => { jobs.push({ resolve, reject }); }));
  let r!: ReactTestRenderer;
  await act(async () => { r = create(<Log />); });
  const input = r.root.findAll((n) => n.type === TextInput && n.props.accessibilityLabel === 'What did you eat?')[0];
  await act(async () => { input.props.onChangeText('kombucha'); });
  await act(async () => { jest.advanceTimersByTime(700); });  // debounce -> AI call -> job pending
  await act(async () => { jest.advanceTimersByTime(2100); }); // first poll of the job (stays open)
  return r;
}
const jump = async (ms: number) => { await act(async () => { jest.setSystemTime(Date.now() + ms); jest.advanceTimersByTime(30_000); }); };

beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(Date.parse('2026-10-17T04:00:00Z')); });
afterEach(() => { jest.useRealTimers(); });

test('Log: 34 min still Estimating; 36 min a failed row with the exact copy, and polling stops', async () => {
  const r = await startEstimating();
  expect(mockStore.api.parseJob).toHaveBeenCalledTimes(1);
  expect(has(r, 'Estimating…')).toBe(true);
  await jump(34 * MIN - 30_000);   // timer tick at 34:00 since the job started (incl. the 30 s tick)
  expect(has(r, 'Estimating…')).toBe(true); expect(has(r, COPY)).toBe(false);
  await jump(2 * MIN - 30_000);    // tick at ~36 min
  expect(has(r, 'Estimating…')).toBe(false);
  expect(has(r, COPY)).toBe(true);
  // the open poll comes back "still pending": the loop sees the row was converted and stops
  await act(async () => { jobs[0].reject(new ParsePending('job1')); });
  await act(async () => { jest.advanceTimersByTime(60_000); });
  expect(mockStore.api.parseJob).toHaveBeenCalledTimes(1);
  // converted row: no kcal until typed, nothing added
  expect(has(r, 'not counted')).toBe(true);
  expect(mockStore.addEntries).not.toHaveBeenCalled();
  await act(async () => { r.unmount(); });
});

test('Log: a late server answer for a converted row is ignored', async () => {
  const r = await startEstimating();
  await jump(36 * MIN);
  expect(has(r, COPY)).toBe(true);
  await act(async () => { jobs[0].resolve(answer); });
  await act(async () => { await Promise.resolve(); });
  expect(has(r, COPY)).toBe(true);          // still the failed row
  expect(has(r, 'Add · 60 kcal')).toBe(false); // no AI estimate row overwrote it
  expect(mockStore.fillPending).not.toHaveBeenCalled();
  await act(async () => { r.unmount(); });
});
