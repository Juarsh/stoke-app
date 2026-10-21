// Tester M2+M3 review (444633c) B1 + O2: the rest-done alert outside the app (one local notification at the stored end,
// rescheduled on ±15s, cancelled on skip / finish / discard; permission asked once, never nagged), the return to the app
// or the logger after the end ("Rest done" + next-set outline, no late vibration, no silent vanish), and TalkBack (no
// ticking live region; announced at start, at 10 s left and at done; a readable time label).
import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { AccessibilityInfo, AppState, AppStateStatus, Platform, Vibration } from 'react-native';

jest.mock('../src/lib/config', () => ({ config: { mock: true, mockAi: false, mockAiDelay: 0 }, flags: {} }));
const mockKv = new Map<string, string>();
jest.mock('../src/lib/kv', () => ({ kv: { get: async (k: string) => mockKv.get(k) ?? null, set: async (k: string, v: string) => { mockKv.set(k, v); } } }));
let mockN = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `id-${++mockN}` }));
jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual('react-native');
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});
jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn(), push: jest.fn(), replace: jest.fn() }) }));
type Perm = { granted: boolean; canAskAgain: boolean; status: string };
const mockNotif = {
  perm: { granted: false, canAskAgain: true, status: 'undetermined' } as Perm,
  grant: true,
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(async () => null),
  getPermissionsAsync: jest.fn(async (): Promise<Perm> => mockNotif.perm),
  requestPermissionsAsync: jest.fn(async (): Promise<Perm> => { mockNotif.perm = { granted: mockNotif.grant, canAskAgain: false, status: mockNotif.grant ? 'granted' : 'denied' }; return mockNotif.perm; }),
  scheduleNotificationAsync: jest.fn(async (_req: unknown) => 'x'),
  cancelScheduledNotificationAsync: jest.fn(async (_id: string) => {}),
  AndroidImportance: { HIGH: 4 }, AndroidNotificationVisibility: { PUBLIC: 1 }, SchedulableTriggerInputTypes: { DATE: 'date' },
};
jest.mock('expo-notifications', () => mockNotif);

import { exercises } from '../src/lib/exercises';
import { StoreProvider } from '../src/lib/store';
import { useWorkouts, Workouts, WORKOUTS_KEY } from '../src/lib/workouts';
import { ASKED_KEY, REST_CHANNEL, REST_ID, restAlert } from '../src/lib/restAlert';
import { spoken } from '../src/features/workout/model';
import { IDLE_MS, RestTimer } from '../src/features/workout/RestTimer';
import { LoggerScreen } from '../src/features/workout/LoggerScreen';

const BENCH = 'wger-73';
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
let w!: Workouts;
function Probe() { w = useWorkouts(); return null; }
const texts = (r: ReactTestRenderer) => r.root.findAll((x) => typeof x.type === 'string').flatMap((x) => [x.props.children].flat()).filter((c) => typeof c === 'string').join('|');
const labels = (r: ReactTestRenderer) => r.root.findAll((x) => typeof x.type === 'string' && x.props.accessibilityLabel).map((x) => String(x.props.accessibilityLabel));
let appListeners: ((s: AppStateStatus) => void)[] = [];
const appState = (s: AppStateStatus) => act(async () => { appListeners.forEach((f) => f(s)); });
beforeEach(() => {
  mockKv.clear(); jest.clearAllMocks();
  mockNotif.perm = { granted: false, canAskAgain: true, status: 'undetermined' }; mockNotif.grant = true;
  appListeners = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_: string, f: (s: AppStateStatus) => void) => { appListeners.push(f); return { remove: () => { appListeners = appListeners.filter((g) => g !== f); } }; }) as never);
});
afterEach(() => jest.restoreAllMocks());

describe('restAlert (the local notification adapter)', () => {
  beforeAll(() => { Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' }); }); // the channel is Android only
  test('first rest asks once, then schedules ONE alert at the end on the rest channel; a reschedule replaces it', async () => {
    const end = Date.now() + 90_000;
    await restAlert.schedule(end, 'Set 2 · 60 kg × 10');
    expect(mockNotif.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(mockNotif.setNotificationChannelAsync).toHaveBeenCalledWith(REST_CHANNEL, expect.objectContaining({ name: 'Rest timer' }));
    expect(mockNotif.scheduleNotificationAsync).toHaveBeenCalledWith({
      identifier: REST_ID,
      content: expect.objectContaining({ title: 'Rest done', body: 'Next: Set 2 · 60 kg × 10' }),
      trigger: { type: 'date', date: new Date(end), channelId: REST_CHANNEL },
    });
    await restAlert.schedule(end + 15_000, null);
    expect(mockNotif.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(mockNotif.cancelScheduledNotificationAsync).toHaveBeenLastCalledWith(REST_ID);
    expect(mockNotif.scheduleNotificationAsync).toHaveBeenLastCalledWith(expect.objectContaining({ identifier: REST_ID, trigger: expect.objectContaining({ date: new Date(end + 15_000) }) }));
    await restAlert.cancel();
    expect(mockNotif.cancelScheduledNotificationAsync).toHaveBeenLastCalledWith(REST_ID);
  });
  test('denied: nothing scheduled and never asked again (no nagging)', async () => {
    mockNotif.grant = false;
    await restAlert.schedule(Date.now() + 90_000, null);
    await restAlert.schedule(Date.now() + 90_000, null);
    expect(mockNotif.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(mockNotif.scheduleNotificationAsync).not.toHaveBeenCalled();
    expect(mockKv.get(ASKED_KEY)).toBe('1');
  });
  test('a rest already over schedules nothing; a throwing native module never breaks the caller', async () => {
    mockNotif.perm = { granted: true, canAskAgain: true, status: 'granted' };
    await restAlert.schedule(Date.now() - 1000, null);
    expect(mockNotif.scheduleNotificationAsync).not.toHaveBeenCalled();
    mockNotif.scheduleNotificationAsync.mockRejectedValueOnce(new Error('no module'));
    await expect(restAlert.schedule(Date.now() + 60_000, null)).resolves.toBeUndefined();
    mockNotif.cancelScheduledNotificationAsync.mockRejectedValueOnce(new Error('no module'));
    await expect(restAlert.cancel()).resolves.toBeUndefined();
  });
});

async function mountTimer(now: number) {
  let r!: ReactTestRenderer;
  await act(async () => { r = create(<StoreProvider><Probe /><RestTimer now={now} repo={exercises} /></StoreProvider>); });
  await flush();
  return r;
}
const at = (r: ReactTestRenderer, now: number) => act(async () => { r.update(<StoreProvider><Probe /><RestTimer now={now} repo={exercises} /></StoreProvider>); });
async function tickFirst() {
  await act(async () => { w.startEmpty(); w.addExercise(BENCH); });
  const x = w.active!.exercises[0];
  await act(async () => { w.setInput(x.id, x.sets[0].id, 'kg_in', '60'); w.setInput(x.id, x.sets[0].id, 'reps_in', '10'); });
  await act(async () => { expect(w.tick(x.id, x.sets[0].id)).toBeNull(); });
  await flush();
  return w.active!.rest!;
}
const scheduled = () => mockNotif.scheduleNotificationAsync.mock.calls.map((c) => (c as unknown as [{ trigger: { date: Date } }])[0].trigger.date.getTime());

describe('the workout keeps the alert in step with the stored end', () => {
  test('tick schedules at ends_at; ±15s reschedules; Skip cancels; finish and discard cancel', async () => {
    const r = await mountTimer(Date.now());
    const rest = await tickFirst();
    expect(scheduled()).toEqual([rest.ends_at]);
    await act(async () => { w.shiftRest(15); }); await flush();
    expect(scheduled()).toEqual([rest.ends_at, rest.ends_at + 15_000]);
    await act(async () => { w.shiftRest(-15); }); await flush();
    expect(scheduled().at(-1)).toBe(rest.ends_at);
    const cancels = () => mockNotif.cancelScheduledNotificationAsync.mock.calls.length;
    let c = cancels();
    await act(async () => { w.endRest(); }); await flush();
    expect(cancels()).toBeGreaterThan(c);
    expect(mockNotif.scheduleNotificationAsync).toHaveBeenCalledTimes(3);
    // a new rest, then Finish (early) cancels it
    const x = w.active!.exercises[0];
    await act(async () => { w.setInput(x.id, x.sets[1].id, 'kg_in', '60'); w.setInput(x.id, x.sets[1].id, 'reps_in', '10'); });
    await act(async () => { expect(w.tick(x.id, x.sets[1].id)).toBeNull(); }); await flush();
    expect(mockNotif.scheduleNotificationAsync).toHaveBeenCalledTimes(4);
    c = cancels();
    await act(async () => { expect(typeof w.finish()).not.toBe('string'); }); await flush();
    expect(cancels()).toBeGreaterThan(c);
    // discard cancels too
    await tickFirst();
    c = cancels();
    await act(async () => { w.discard(); }); await flush();
    expect(cancels()).toBeGreaterThan(c);
    expect(mockNotif.requestPermissionsAsync).toHaveBeenCalledTimes(1); // asked the first time only
    await act(async () => { r.unmount(); });
  });
});

describe('back to the app / the logger after the rest ended', () => {
  test('background through the end: on return "Rest done" shows, no late vibration, and it fades 8 s after the return', async () => {
    const vib = jest.spyOn(Vibration, 'vibrate').mockImplementation(() => {});
    const r = await mountTimer(Date.now());
    const rest = await tickFirst();
    await appState('background');
    await at(r, rest.ends_at + 120_000); // JS may still tick in the background: nothing ends, nothing vibrates
    expect(w.active!.rest).not.toBeNull();
    expect(vib).not.toHaveBeenCalled();
    const back = rest.ends_at + 125_000;
    jest.spyOn(Date, 'now').mockReturnValue(back);
    await appState('active');
    await at(r, back);
    expect(texts(r)).toContain('Rest done');
    expect(w.active!.rest).not.toBeNull();
    await at(r, back + IDLE_MS - 1000);
    expect(w.active!.rest).not.toBeNull(); // not silently gone
    expect(vib).not.toHaveBeenCalled();
    await at(r, back + IDLE_MS + 10);
    expect(w.active!.rest).toBeNull();
    await act(async () => { r.unmount(); });
  });
  test('back within 5 s of the end: it still vibrates once', async () => {
    const vib = jest.spyOn(Vibration, 'vibrate').mockImplementation(() => {});
    const r = await mountTimer(Date.now());
    const rest = await tickFirst();
    await appState('background');
    jest.spyOn(Date, 'now').mockReturnValue(rest.ends_at + 3000);
    await appState('active');
    await at(r, rest.ends_at + 3000);
    expect(vib).toHaveBeenCalledTimes(1);
    await act(async () => { r.unmount(); });
  });
  test('the logger remounting after the end: "Rest done · Set 2" pill and the next set outlined, no vibration', async () => {
    const vib = jest.spyOn(Vibration, 'vibrate').mockImplementation(() => {});
    let r!: ReactTestRenderer;
    await act(async () => { r = create(<StoreProvider><Probe /></StoreProvider>); });
    await flush();
    const rest = await tickFirst();
    await act(async () => { r.unmount(); });
    const saved = JSON.parse(mockKv.get(WORKOUTS_KEY)!);
    saved.active.rest.ends_at = Date.now() - 60_000; // it ended a minute ago while the logger was off screen
    mockKv.set(WORKOUTS_KEY, JSON.stringify(saved));
    await act(async () => { r = create(<StoreProvider><Probe /><LoggerScreen repo={exercises} /></StoreProvider>); });
    await flush();
    expect(texts(r)).toContain('Rest done');
    expect(texts(r)).toContain(' · Set 2');
    expect(r.root.findAll((x) => typeof x.type === 'string' && x.props.testID === 'next-set')).toHaveLength(1);
    expect(rest.set_id).toBe(w.active!.exercises[0].sets[1].id);
    expect(vib).not.toHaveBeenCalled();
    await act(async () => { r.unmount(); });
  });
});

describe('TalkBack (O2)', () => {
  test('spoken times', () => {
    expect([spoken(80), spoken(45), spoken(120), spoken(61), spoken(1)]).toEqual(['1 minute 20 seconds', '45 seconds', '2 minutes', '1 minute 1 second', '1 second']);
  });
  test('no live region; announced at start, at 10 s left and at done only; readable label', async () => {
    jest.spyOn(Vibration, 'vibrate').mockImplementation(() => {});
    const say = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    const start = Date.now();
    const r = await mountTimer(start);
    const rest = await tickFirst();
    await at(r, rest.ends_at - 90_000);
    expect(say.mock.calls.map((c) => c[0])).toEqual(['Rest started, 1 minute 30 seconds. Next: Set 2']);
    for (let s = 89; s >= 11; s--) await at(r, rest.ends_at - s * 1000);
    expect(say).toHaveBeenCalledTimes(1); // nothing per second
    expect(labels(r).some((l) => l.startsWith('Rest, 11 seconds left'))).toBe(true);
    await at(r, rest.ends_at - 10_000);
    for (let s = 9; s >= 1; s--) await at(r, rest.ends_at - s * 1000);
    await at(r, rest.ends_at + 200);
    await at(r, rest.ends_at + 1200);
    expect(say.mock.calls.map((c) => c[0])).toEqual(['Rest started, 1 minute 30 seconds. Next: Set 2', '10 seconds left', 'Rest done. Next: Set 2']);
    expect(r.root.findAll((x) => x.props.accessibilityLiveRegion)).toHaveLength(0);
    // expanded card: readable time too, no live region
    await at(r, rest.ends_at + 1300);
    await act(async () => { r.root.findAll((x) => typeof x.props.onPress === 'function' && /Open rest timer$/.test(String(x.props.accessibilityLabel)))[0].props.onPress(); });
    await act(async () => { w.shiftRest(15); });
    await at(r, rest.ends_at + 1300 + 1000);
    expect(labels(r).some((l) => /^Rest, 1[34] seconds left of /.test(l))).toBe(true);
    expect(r.root.findAll((x) => x.props.accessibilityLiveRegion)).toHaveLength(0);
    await act(async () => { r.unmount(); });
  });
});
