// Health: ONE interface (src/lib/health.ts) with two adapters, Apple Health (iOS, @kingstinct/react-native-healthkit)
// and Health Connect (Android), picked by platform + flag. Steps only. The native modules are mocked here; the factory
// counters prove they are never even loaded with the flag off, in Expo Go, or on the wrong platform.
import React from 'react';
import { Platform } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';

const mockFlags = { steps: true, healthConnect: false, healthKit: false, community: true, googleSignIn: false };
jest.mock('../src/lib/config', () => ({ config: { mock: true, apiUrl: '', mockAi: false, mockAiDelay: 0, google: { android: '', web: '', ios: '' } }, get flags() { return mockFlags; }, brand: { name: 'Stoke' } }));
const mockEnv = { executionEnvironment: 'standalone' as string };
jest.mock('expo-constants', () => ({ __esModule: true, default: { get executionEnvironment() { return mockEnv.executionEnvironment; }, expoConfig: { extra: {} } } }));
const mockLoads = { hk: 0, hc: 0 };
const mockHk = { isHealthDataAvailable: jest.fn(() => true), getRequestStatusForAuthorization: jest.fn(async () => 1), requestAuthorization: jest.fn(async () => true),
  queryStatisticsForQuantity: jest.fn(async () => ({ sumQuantity: { quantity: 4321.6, unit: 'count' }, sources: [] })) };
jest.mock('@kingstinct/react-native-healthkit', () => { mockLoads.hk++; return mockHk; });
const mockHc = { getSdkStatus: jest.fn(async () => 3), initialize: jest.fn(async () => true), getGrantedPermissions: jest.fn(async () => [] as unknown[]),
  requestPermission: jest.fn(async () => [{ accessType: 'read', recordType: 'Steps' }]),
  readRecords: jest.fn(async () => ({ records: [{ count: 1200 }, { count: 800 }] })) };
jest.mock('react-native-health-connect', () => { mockLoads.hc++; return mockHc; });
jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual('react-native');
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});
jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn(), push: jest.fn(), replace: jest.fn() }), useSegments: () => [], useLocalSearchParams: () => ({}) }));
jest.mock('../src/lib/kv', () => ({ kv: { get: async () => null, set: async () => {} } }));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'uuid' }));
let mockOS: 'ios' | 'android' | 'web' = 'ios';
Object.defineProperty(Platform, 'OS', { get: () => mockOS, configurable: true });

import { connectSteps, healthAdapter, healthName, readTodaySteps, stepsStatus, stepsWindow } from '../src/lib/health';
import Settings from '../src/app/settings';
import { StoreProvider, useStore } from '../src/lib/store';
import { healthKit } from '../src/lib/healthKit';
import { healthConnect } from '../src/lib/healthConnect';

const prompts = () => mockHk.requestAuthorization.mock.calls.length + mockHc.requestPermission.mock.calls.length;
const reads = () => mockHk.queryStatisticsForQuantity.mock.calls.length + mockHc.readRecords.mock.calls.length;
const setup = (os: typeof mockOS, f: Partial<typeof mockFlags> = {}, env = 'standalone') => {
  mockOS = os; Object.assign(mockFlags, { steps: true, healthConnect: false, healthKit: false }, f); mockEnv.executionEnvironment = env;
};
beforeEach(() => { jest.clearAllMocks(); mockHk.getRequestStatusForAuthorization.mockResolvedValue(1); mockHc.getGrantedPermissions.mockResolvedValue([]); });

describe('picking the adapter (platform + flag); Expo Go and flag-off never load native code', () => {
  test('nothing is loaded just by importing health.ts', () => { expect(mockLoads).toEqual({ hk: 0, hc: 0 }); });
  test.each([
    ['ios', { healthKit: true }, 'standalone', 'Apple Health'],
    ['android', { healthConnect: true }, 'standalone', 'Health Connect'],
    ['ios', {}, 'standalone', null], // EXPO_PUBLIC_FLAG_HEALTHKIT off (the default)
    ['android', {}, 'standalone', null],
    ['ios', { healthConnect: true }, 'standalone', null], // the Android flag does not turn on iOS
    ['android', { healthKit: true }, 'standalone', null],
    ['ios', { healthKit: true, healthConnect: true }, 'storeClient', null], // Expo Go
    ['android', { healthKit: true, healthConnect: true }, 'storeClient', null],
    ['ios', { healthKit: true, steps: false }, 'standalone', null], // steps cut flag
    ['web', { healthKit: true, healthConnect: true }, 'standalone', null],
  ] as const)('%s %j %s -> %s', (os, f, env, name) => { setup(os, f, env); expect(healthAdapter()?.name ?? null).toBe(name); });
  test.each([['ios', {}, 'standalone'], ['ios', { healthKit: true, healthConnect: true }, 'storeClient'], ['android', {}, 'standalone'], ['android', { healthKit: true, healthConnect: true }, 'storeClient']] as const)(
    '%s %j %s: unavailable, no prompt, no read, native module never loaded', async (os, f, env) => {
      setup(os, f, env);
      expect(await stepsStatus()).toBe('unavailable');
      expect(await readTodaySteps()).toBeNull();
      expect(await connectSteps()).toBe(false);
      expect(prompts()).toBe(0); expect(reads()).toBe(0);
      expect(mockLoads).toEqual({ hk: 0, hc: 0 });
    });
});

describe('Apple Health adapter (iOS)', () => {
  beforeEach(() => setup('ios', { healthKit: true }));
  test('status never prompts: not asked yet -> not_connected; already asked -> connected; no HealthKit -> unavailable', async () => {
    expect(await stepsStatus()).toBe('not_connected');
    expect(mockHk.getRequestStatusForAuthorization).toHaveBeenCalledWith({ toRead: ['HKQuantityTypeIdentifierStepCount'] });
    mockHk.getRequestStatusForAuthorization.mockResolvedValue(2);
    expect(await stepsStatus()).toBe('connected');
    mockHk.isHealthDataAvailable.mockReturnValueOnce(false);
    expect(await stepsStatus()).toBe('unavailable');
    expect(prompts()).toBe(0);
    expect(mockLoads.hc).toBe(0);
  });
  test('connect asks for steps read only (nothing to write)', async () => {
    expect(await connectSteps()).toBe(true);
    expect(mockHk.requestAuthorization).toHaveBeenCalledTimes(1);
    expect(mockHk.requestAuthorization).toHaveBeenCalledWith({ toRead: ['HKQuantityTypeIdentifierStepCount'] });
  });
  test('reads the cumulative step sum over the 4 AM day, rounded; not connected -> null without reading', async () => {
    expect(await readTodaySteps()).toBeNull(); expect(reads()).toBe(0);
    mockHk.getRequestStatusForAuthorization.mockResolvedValue(2);
    const now = new Date('2026-10-21T15:00:00+05:30');
    expect(await readTodaySteps(now)).toBe(4322);
    expect(mockHk.queryStatisticsForQuantity).toHaveBeenCalledWith('HKQuantityTypeIdentifierStepCount', ['cumulativeSum'],
      { filter: { date: { startDate: new Date('2026-10-21T04:00:00+05:30'), endDate: now } }, unit: 'count' });
    mockHk.queryStatisticsForQuantity.mockResolvedValueOnce({ sources: [] } as never);
    expect(await readTodaySteps(now)).toBe(0); // no samples
    expect(prompts()).toBe(0);
  });
  test('fails soft: a throwing module gives unavailable / false / null', async () => {
    mockHk.getRequestStatusForAuthorization.mockRejectedValueOnce(new Error('boom'));
    expect(await stepsStatus()).toBe('unavailable');
    mockHk.requestAuthorization.mockRejectedValueOnce(new Error('boom'));
    expect(await connectSteps()).toBe(false);
    mockHk.getRequestStatusForAuthorization.mockResolvedValue(2);
    mockHk.queryStatisticsForQuantity.mockRejectedValueOnce(new Error('boom'));
    expect(await readTodaySteps()).toBeNull();
  });
});

describe('Health Connect adapter (Android)', () => {
  beforeEach(() => setup('android', { healthConnect: true }));
  test('status never prompts: granted steps -> connected; none -> not_connected; no Health Connect -> unavailable', async () => {
    expect(await stepsStatus()).toBe('not_connected');
    mockHc.getGrantedPermissions.mockResolvedValue([{ accessType: 'read', recordType: 'Steps' }]);
    expect(await stepsStatus()).toBe('connected');
    mockHc.getSdkStatus.mockResolvedValueOnce(1);
    expect(await stepsStatus()).toBe('unavailable');
    expect(prompts()).toBe(0);
  });
  test('connect asks for steps read only', async () => {
    expect(await connectSteps()).toBe(true);
    expect(mockHc.requestPermission).toHaveBeenCalledWith([{ accessType: 'read', recordType: 'Steps' }]);
    mockHc.requestPermission.mockResolvedValueOnce([]);
    expect(await connectSteps()).toBe(false); // denied
  });
  test('sums the Steps records over the 4 AM day', async () => {
    mockHc.getGrantedPermissions.mockResolvedValue([{ accessType: 'read', recordType: 'Steps' }]);
    const now = new Date('2026-10-21T09:15:00+05:30');
    expect(await readTodaySteps(now)).toBe(2000);
    expect(mockHc.readRecords).toHaveBeenCalledWith('Steps', { timeRangeFilter: { operator: 'between', startTime: '2026-10-20T22:30:00.000Z', endTime: now.toISOString() } });
    expect(prompts()).toBe(0);
  });
});

describe('the 4 AM day window (dayOf)', () => {
  test.each([
    ['2026-10-21T03:59:00+05:30', '2026-10-20T04:00:00+05:30'], // before 4 AM: still yesterday's log day
    ['2026-10-21T04:00:00+05:30', '2026-10-21T04:00:00+05:30'],
    ['2026-10-21T23:59:00+05:30', '2026-10-21T04:00:00+05:30'],
    ['2026-10-22T00:30:00+05:30', '2026-10-21T04:00:00+05:30'], // after midnight: counts toward the day that began at 4 AM
  ])('%s -> from %s', (now, from) => {
    const w = stepsWindow(new Date(now));
    expect(w.from.getTime()).toBe(new Date(from).getTime()); expect(w.to.getTime()).toBe(new Date(now).getTime());
  });
  test('both adapters get the same window', async () => {
    const now = new Date('2026-10-22T01:00:00+05:30');
    setup('ios', { healthKit: true }); mockHk.getRequestStatusForAuthorization.mockResolvedValue(2);
    await readTodaySteps(now);
    setup('android', { healthConnect: true }); mockHc.getGrantedPermissions.mockResolvedValue([{ accessType: 'read', recordType: 'Steps' }]);
    await readTodaySteps(now);
    const hkFrom = (mockHk.queryStatisticsForQuantity.mock.calls[0] as unknown as [string, string[], { filter: { date: { startDate: Date } } }])[2].filter.date.startDate;
    const hcFrom = (mockHc.readRecords.mock.calls[0] as unknown as [string, { timeRangeFilter: { startTime: string } }])[1].timeRangeFilter.startTime;
    expect(hkFrom.toISOString()).toBe(hcFrom);
    expect(hcFrom).toBe(new Date('2026-10-21T04:00:00+05:30').toISOString());
  });
});

describe('adapters are the only place each library is called', () => {
  test('each adapter has exactly one prompt call, inside connect()', () => {
    const { readFileSync } = jest.requireActual('fs') as typeof import('fs');
    const src = (p: string) => readFileSync(require('path').join(__dirname, '..', p), 'utf8') as string;
    const hk = src('src/lib/healthKit.ts'); const hc = src('src/lib/healthConnect.ts');
    expect(hk.match(/requestAuthorization\(/g)).toHaveLength(1);
    expect(hk.slice(hk.indexOf('async connect()'), hk.indexOf('async steps('))).toMatch(/requestAuthorization\(/);
    expect(hc.match(/requestPermission\(/g)).toHaveLength(1);
    expect(hc.slice(hc.indexOf('async connect()'), hc.indexOf('async steps('))).toMatch(/requestPermission\(/);
    expect(src('src/lib/health.ts')).not.toMatch(/requestAuthorization|requestPermission|react-native-health-connect'\)|react-native-healthkit'\)/);
    // lazy: no top-level import of either native library anywhere in src/
    expect(hk).not.toMatch(/^import [^t].*react-native-healthkit/m); expect(hc).not.toMatch(/^import [^t].*react-native-health-connect/m);
  });
  test('adapters expose only steps (no speculative extras)', () => {
    expect(Object.keys(healthKit).sort()).toEqual(['connect', 'name', 'status', 'steps']);
    expect(Object.keys(healthConnect).sort()).toEqual(['connect', 'install', 'name', 'status', 'steps']);
  });
});

describe('UI names and no prompt on load', () => {
  test('"Apple Health" on iOS, "Health Connect" on Android', () => {
    mockOS = 'ios'; expect(healthName()).toBe('Apple Health'); mockOS = 'android'; expect(healthName()).toBe('Health Connect');
  });
  test.each(['ios', 'android'] as const)('%s: rendering Settings (store on, not yet asked) never prompts; the row names the store', async (os) => {
    setup(os, { healthKit: true, healthConnect: true });
    let st!: ReturnType<typeof useStore>;
    const Probe = () => { st = useStore(); return null; };
    let r!: ReactTestRenderer;
    await act(async () => { r = create(<StoreProvider><Probe /></StoreProvider>); });
    await act(async () => { st.setProfile({ goal: 'maintain', sex: 'x', age: 30, heightCm: 170, weightKg: 70, activity: 'moderate', diet: 'veg', kcalTarget: 2200, proteinTarget: 80, stepsTarget: 8000, addStepKcal: false, showKcalOnCards: true }); });
    await act(async () => { r.update(<StoreProvider><Probe /><Settings /></StoreProvider>); });
    await act(async () => { await new Promise((res) => setTimeout(res, 10)); });
    const txt = r.root.findAll((x) => typeof x.type === 'string').flatMap((x) => [x.props.children].flat()).filter((c) => typeof c === 'string').join('|');
    expect(txt).toContain(os === 'ios' ? 'Apple Health steps' : 'Health Connect steps');
    expect(txt).toContain('Connect');
    expect(prompts()).toBe(0);
  });
});
