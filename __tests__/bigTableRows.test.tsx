// CEO N1 (rg3): the 1-5000 limit is ONLY for kcal the user types. A table / dish / confirmed row saves whatever its size,
// like the server. And no row is ever dropped silently: a row the store guard refuses stays open with the reason.
import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { TextInput } from 'react-native';

jest.mock('../src/lib/config', () => ({ config: { mock: true, mockAi: false, mockAiDelay: 0 }, flags: {} }));
let mockSaved: string | null = null;
jest.mock('../src/lib/kv', () => ({ kv: { get: async () => mockSaved, set: async (_k: string, v: string) => { mockSaved = v; } } }));
let mockN = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `id${++mockN}` }));
const mockNav = jest.fn();
jest.mock('expo-router', () => {
  const R = jest.requireActual('react');
  return {
    useFocusEffect: (cb: () => (() => void) | void) => R.useEffect(() => cb(), []),
    useRouter: () => ({ navigate: mockNav, push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
    useLocalSearchParams: () => ({}),
  };
});
jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual('react-native');
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});

import { StoreProvider, Store, useStore } from '../src/lib/store';
import { counted, entryFromItem, entryRefusal, FoodEntry, localDate, NO_KCAL_REASON, reviewEntry, TYPED_KCAL_REASON } from '../src/lib/domain';
import { DISH_TABLE_VERSION, parser } from '../src/parser';
import Log from '../src/app/(tabs)/log';
import Today from '../src/app/(tabs)/index';
import Review from '../src/app/review';

let st!: Store;
const live: ReactTestRenderer[] = [];
afterEach(async () => { for (const r of live.splice(0)) await act(async () => { try { r.unmount(); } catch { /* already */ } }); });
function Probe() { st = useStore(); return null; }
const texts = (r: ReactTestRenderer) => r.root.findAll((n) => typeof n.type === 'string').flatMap((n) => [n.props.children].flat()).filter((c) => typeof c === 'string') as string[];
const textOf = (r: { root: ReactTestRenderer['root'] }) => texts(r as ReactTestRenderer).join('').replace(/\s+/g, ' ');
const press = async (r: ReactTestRenderer, label: RegExp, last = false) => {
  const b = r.root.findAll((n) => typeof n.props.onPress === 'function' && (label.test(String(n.props.accessibilityLabel ?? '')) || label.test(textOf({ root: n }))));
  if (!b.length) throw new Error(`no button ${label}: ${texts(r).join(' | ')}`);
  await act(async () => { b[last ? b.length - 1 : 0].props.onPress(); });
};
const today = localDate();
async function mount(screen: React.ReactElement) {
  mockSaved = JSON.stringify({ user: { id: 'u', name: 'A', email: 'a@x', idToken: null, mock: true }, entries: [], queue: [], aiQuota: { used: 0 },
    profile: { goal: 'maintain', sex: 'm', age: 30, heightCm: 172, weightKg: 68, activity: 'light', diet: 'veg', kcalTarget: 2350, proteinTarget: 82, stepsTarget: 8000, addStepKcal: false, showKcalOnCards: true } });
  let r!: ReactTestRenderer;
  await act(async () => { r = create(<StoreProvider><Probe />{screen}</StoreProvider>); });
  live.push(r);
  await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
  return r;
}
async function say(r: ReactTestRenderer, text: string) {
  const input = r.root.findAll((n) => n.type === TextInput && n.props.accessibilityLabel === 'What did you eat?')[0];
  await act(async () => { input.props.onChangeText(text); });
  await act(async () => { await new Promise((res) => setTimeout(res, 800)); }); // debounce + local parse
}
const saved = () => st.entries.filter((e) => counted(e));

test('entryRefusal: the 1-5000 rule is for typed kcal only; any table / dish row saves at its size', () => {
  const [roti] = parser.parse('60 roti').items;
  const big = entryFromItem({ ...roti, quantity: 60, needs_confirmation: false, kcal: { low: 6600, best: 6600, high: 6600 } }, { id: 't', slot: 'lunch', raw_text: '60 roti', local_date: today, tableVersion: DISH_TABLE_VERSION });
  expect(big.source).not.toBe('custom');
  expect(entryRefusal(big)).toBeNull();
  expect(entryRefusal({ ...big, kcal: { low: 99999, best: 99999, high: 99999 } })).toBeNull();
  expect(entryRefusal({ ...big, kcal: { low: NaN, best: NaN, high: NaN } })).toBe(NO_KCAL_REASON);
  const typed = (k: number): FoodEntry => ({ ...big, dish_id: null, custom_name: 'x', source: 'custom', kcal: { low: k, best: k, high: k } });
  for (const k of [5001, 6000, 0, -1, NaN]) expect(entryRefusal(typed(k))).toBe(TYPED_KCAL_REASON);
  for (const k of [1, 5000]) expect(entryRefusal(typed(k))).toBeNull();
});

test('60 roti -> pick "60 pieces · 6,600 kcal" -> Add saves 6600 and Today shows it', async () => {
  const r = await mount(<Log />);
  await say(r, '60 roti');
  expect(textOf(r)).toMatch(/60 pieces · 6,600 kcal/);
  await press(r, /60 pieces · 6,600 kcal/);
  await press(r, /^Add 6,600 kcal/);
  expect(saved().map((e) => [e.dish_id, e.qty, e.kcal.best])).toEqual([['roti', 60, 6600]]);
  expect(mockNav).toHaveBeenCalledWith('/');
  const t = r; // Today on the same store
  await act(async () => { t.update(<StoreProvider><Probe /><Today /></StoreProvider>); });
  const ring = t.root.findAll((n) => typeof n.props.eaten === 'number' && 'kcalLeft' in n.props)[0];
  expect(ring.props.eaten).toBe(6600);
  expect(t.root.findAll((n) => typeof n.props.accessibilityLabel === 'string' && /6600 calories/.test(n.props.accessibilityLabel)).length).toBeGreaterThan(0);
  await act(async () => { t.unmount(); });
});

test('"12 plate chole bhature" -> pick 24 pieces: both rows saved (bhatura 6,960)', async () => {
  const r = await mount(<Log />);
  await say(r, '12 plate chole bhature');
  expect(textOf(r)).toMatch(/Bhatura.*24 pieces.*6,960/);
  await press(r, /^12 katori$/, true); // the "Did you mean" choices
  await press(r, /^24 pieces$/, true);
  await press(r, /^Add [0-9,]+ kcal/);
  const rows = saved().map((e) => [e.dish_id, e.kcal.best]);
  expect(rows).toContainEqual(['bhatura', 6960]);
  expect(rows.length).toBe(2);
  await act(async () => { r.unmount(); });
});

test('typed 5001 is still refused: the review row stays visible with the reason, nothing counted', async () => {
  mockSaved = null;
  const r = await mount(<Review />);
  const it = { ...parser.unknown('zorbu'), needs_input: true } as never;
  await act(async () => { st.addEntries([reviewEntry(it, { id: 'R1', slot: 'lunch', raw_text: 'zorbu', local_date: today, tableVersion: DISH_TABLE_VERSION })]); });
  const field = () => r.root.findAll((n) => typeof n.props.onAdd === 'function' && n.props.name === 'zorbu')[0];
  expect(field()).toBeDefined();
  await act(async () => { field().props.onAdd(5001); }); // forced past the disabled button
  expect(saved()).toEqual([]);
  expect(field()).toBeDefined(); // the row is still there
  expect(textOf(r)).toContain(`Not saved: ${TYPED_KCAL_REASON}`);
  await act(async () => { field().props.onAdd(5000); });
  expect(saved().map((e) => e.kcal.best)).toEqual([5000]);
  await act(async () => { r.unmount(); });
});
