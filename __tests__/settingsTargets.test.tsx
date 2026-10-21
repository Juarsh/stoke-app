// Bug fix (Oct 21, owner on iPhone / Expo Go): the daily calorie target in Settings could not be updated.
// Was: uncontrolled defaultValue + onEndEditing(Number(e.nativeEvent.text) || old) — iOS number pad has no return key and
// nativeEvent.text can be undefined, so the change was silently dropped. Now controlled input + explicit Save + reasons.
import React from 'react';
import { Keyboard } from 'react-native';
import { act, create, ReactTestRenderer } from 'react-test-renderer';

jest.mock('../src/lib/config', () => ({ config: { mock: true, apiUrl: '', mockAi: false, mockAiDelay: 0 }, flags: {} }));
const mockKv = new Map<string, string>();
jest.mock('../src/lib/kv', () => ({ kv: { get: async (k: string) => mockKv.get(k) ?? null, set: async (k: string, v: string) => { mockKv.set(k, v); } } }));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'uuid' }));
jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual('react-native');
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});
jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn(), push: jest.fn(), replace: jest.fn() }), useSegments: () => ['settings'], useLocalSearchParams: () => ({}) }));

import Settings from '../src/app/settings';
import { Profile, targetError, targetNumber, TARGET_LIMITS } from '../src/lib/domain';
import { StoreProvider, useStore } from '../src/lib/store';
import { useDay } from '../src/lib/useDay';
import { foodCard } from '../src/features/home/model';
import { TARGETS_DONE_ID } from '../src/features/settings/TargetsCard';

const base: Profile = { goal: 'maintain', sex: 'm', age: 30, heightCm: 175, weightKg: 75, activity: 'moderate', diet: 'veg',
  kcalTarget: 2630, proteinTarget: 90, maintenanceKcal: 2633, stepsTarget: 8000, addStepKcal: false, showKcalOnCards: true };

let st!: ReturnType<typeof useStore>; let day!: ReturnType<typeof useDay>;
function Probe() { st = useStore(); day = useDay(); return null; }
const texts = (r: ReactTestRenderer) => r.root.findAll((x) => typeof x.type === 'string').flatMap((x) => [x.props.children].flat()).filter((c) => typeof c === 'string').join('|');
const input = (r: ReactTestRenderer, l: string) => r.root.findAll((x) => typeof x.props.onChangeText === 'function' && x.props.accessibilityLabel === l)[0];
const saveBtn = (r: ReactTestRenderer) => r.root.findAll((x) => typeof x.props.onPress === 'function' && x.props.accessibilityLabel === 'Save targets' && x.props.accessibilityState)[0];
const type = (r: ReactTestRenderer, l: string, v: string) => act(async () => { input(r, l).props.onChangeText(v); });
const save = (r: ReactTestRenderer) => act(async () => { saveBtn(r).props.onPress(); });

async function mount(p: Profile = base) {
  mockKv.clear();
  let r!: ReactTestRenderer;
  await act(async () => { r = create(<StoreProvider><Probe /></StoreProvider>); });
  await act(async () => { st.setProfile(p); });
  await act(async () => { r.update(<StoreProvider><Probe /><Settings /></StoreProvider>); });
  return r;
}

describe('target parsing and limits (same as onboarding / server: 1,200–6,000 kcal, ≤500 under maintenance)', () => {
  test('limits', () => expect(TARGET_LIMITS).toEqual({ kcalTarget: [1200, 6000], proteinTarget: [10, 400] }));
  test('"1,800" is 1800; junk and undefined are null (never a default)', () => {
    expect(targetNumber('1,800')).toBe(1800); expect(targetNumber(' 2 100 ')).toBe(2100);
    for (const x of ['', '18.5', '-5', '2k', undefined, null]) expect(targetNumber(x as string)).toBeNull();
  });
  test.each([
    ['kcalTarget', '1199', 'Enter a daily target from 1,200 to 6,000 kcal.'], ['kcalTarget', '6001', 'Enter a daily target from 1,200 to 6,000 kcal.'],
    ['kcalTarget', '', 'Enter whole calories, digits only.'], ['kcalTarget', '1800.5', 'Enter whole calories, digits only.'],
    ['proteinTarget', '9', 'Enter a protein target from 10 to 400 g.'], ['proteinTarget', '401', 'Enter a protein target from 10 to 400 g.'],
    ['proteinTarget', 'abc', 'Enter whole grams, digits only.'],
  ] as const)('%s "%s" -> %s', (k, v, msg) => expect(targetError(k, v)).toBe(msg));
  test('edges allowed', () => {
    expect(targetError('kcalTarget', '1200')).toBeNull(); expect(targetError('kcalTarget', '6,000')).toBeNull();
    expect(targetError('proteinTarget', '10')).toBeNull(); expect(targetError('proteinTarget', '400')).toBeNull();
  });
  test('more than 500 under maintenance is refused with the minimum to enter', () => {
    expect(targetError('kcalTarget', '2100', 2633)).toBe('That’s more than 500 kcal below your maintenance (2,633). Enter 2,140 or more.');
    expect(targetError('kcalTarget', '2140', 2633)).toBeNull();
  });
});

describe('Settings → Targets', () => {
  test('controlled number-pad inputs with a Done bar on iOS; Save starts disabled', async () => {
    const r = await mount();
    const k = input(r, 'Daily kcal');
    expect(k.props.value).toBe('2630'); expect(k.props.keyboardType).toBe('number-pad'); expect(k.props.inputAccessoryViewID).toBe(TARGETS_DONE_ID);
    expect(k.props.onEndEditing).toBeUndefined(); expect(k.props.defaultValue).toBeUndefined();
    expect(input(r, 'Protein').props.value).toBe('90');
    expect(r.root.findAll((x) => x.props.nativeID === TARGETS_DONE_ID).length).toBeGreaterThan(0);
    expect(saveBtn(r).props.disabled).toBe(true);
    const done = r.root.findAll((x) => typeof x.props.onPress === 'function' && x.props.accessibilityLabel === 'Done' && x.props.accessibilityRole === 'button')[0];
    const spy = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
    await act(async () => { done.props.onPress(); }); expect(spy).toHaveBeenCalled(); spy.mockRestore();
  });

  test('typing a new kcal + Save updates the profile, Home ring and goal at once; input shows the saved value', async () => {
    const r = await mount();
    await type(r, 'Daily kcal', '2,400');
    expect(saveBtn(r).props.disabled).toBe(false);
    await save(r);
    expect(st.profile?.kcalTarget).toBe(2400);
    expect(day.kcalTarget).toBe(2400);
    expect(foodCard(day.entries, day.kcalTarget, day.proteinTarget).kcalTarget).toBe(2400);
    expect(input(r, 'Daily kcal').props.value).toBe('2400');
    expect(saveBtn(r).props.disabled).toBe(true);
    expect(texts(r)).toMatch(/Saved\. Home uses 2,400 kcal and 90 g protein\./);
    expect(JSON.parse(mockKv.get([...mockKv.keys()].find((x) => mockKv.get(x)!.includes('"profile"'))!)!).profile.kcalTarget).toBe(2400);
  });

  test('protein saves the same way', async () => {
    const r = await mount();
    await type(r, 'Protein', '120'); await save(r);
    expect(st.profile?.proteinTarget).toBe(120); expect(day.proteinTarget).toBe(120); expect(st.profile?.kcalTarget).toBe(2630);
  });

  test('out-of-range value: reason shown in the warn colour, Save disabled, nothing saved or clamped', async () => {
    const r = await mount();
    await type(r, 'Daily kcal', '900');
    expect(texts(r)).toMatch(/Enter a daily target from 1,200 to 6,000 kcal\./);
    const warn = r.root.findAll((x) => x.props.tone === 'warn');
    expect(warn.length).toBeGreaterThan(0);
    expect(saveBtn(r).props.disabled).toBe(true);
    await save(r);
    expect(st.profile?.kcalTarget).toBe(2630);
    expect(input(r, 'Daily kcal').props.value).toBe('900'); // the typed value stays, it is not replaced
    await type(r, 'Protein', '500');
    expect(texts(r)).toMatch(/Enter a protein target from 10 to 400 g\./);
  });

  test('empty / non-digit input is refused with a reason, never replaced by the old value', async () => {
    const r = await mount();
    await type(r, 'Daily kcal', '');
    expect(texts(r)).toMatch(/Enter whole calories, digits only\./);
    expect(saveBtn(r).props.disabled).toBe(true);
    await type(r, 'Daily kcal', '18.5');
    expect(saveBtn(r).props.disabled).toBe(true);
    expect(st.profile?.kcalTarget).toBe(2630);
  });

  test('more than 500 under maintenance: refused with the reason the server would give', async () => {
    const r = await mount();
    await type(r, 'Daily kcal', '1500');
    expect(texts(r)).toMatch(/more than 500 kcal below your maintenance/);
    expect(saveBtn(r).props.disabled).toBe(true);
  });

  test('regression: an end-editing event with undefined text (iOS) no longer drops a typed value', async () => {
    const r = await mount();
    await type(r, 'Daily kcal', '2500');
    const k = input(r, 'Daily kcal');
    // the old code read e.nativeEvent.text here and fell back to the old value; now end-editing does nothing to the draft
    await act(async () => { k.props.onEndEditing?.({ nativeEvent: { text: undefined } }); k.props.onBlur?.({ nativeEvent: {} }); });
    expect(input(r, 'Daily kcal').props.value).toBe('2500');
    expect(saveBtn(r).props.disabled).toBe(false);
    await save(r);
    expect(st.profile?.kcalTarget).toBe(2500);
  });

  test('typing back the stored value leaves Save disabled; an outside profile change shows in the input', async () => {
    const r = await mount();
    await type(r, 'Daily kcal', '2630');
    expect(saveBtn(r).props.disabled).toBe(true);
    const r2 = await mount();
    await act(async () => { st.setProfile({ ...st.profile!, kcalTarget: 2700 }); });
    expect(input(r2, 'Daily kcal').props.value).toBe('2700');
  });
});
