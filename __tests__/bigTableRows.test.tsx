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
import { counted, entryFromItem, entryRefusal, FoodEntry, dayOf, localDate, NO_KCAL_REASON, reviewEntry, TYPED_KCAL_REASON } from '../src/lib/domain';
import { DISH_TABLE_VERSION, parser } from '../src/parser';
import Log from '../src/app/(tabs)/log';
import Today from '../src/features/today/TodayScreen';
import Review from '../src/app/review';
import { EditSheet } from '../src/components/ItemEditor';

// F5 (rg4): real screens + real store; never flake on a busy box
jest.setTimeout(30_000);

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
const today = dayOf();
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

test('entryRefusal: the 1-5000 rule is for typed kcal only; a table row saves at its size up to 10,000 kcal / 500 g (rg7 H1)', () => {
  const [roti] = parser.parse('60 roti').items;
  const big = entryFromItem({ ...roti, quantity: 60, needs_confirmation: false, kcal: { low: 6600, best: 6600, high: 6600 } }, { id: 't', slot: 'lunch', raw_text: '60 roti', local_date: today, tableVersion: DISH_TABLE_VERSION });
  expect(big.source).not.toBe('custom');
  expect(entryRefusal(big)).toBeNull();
  expect(entryRefusal({ ...big, kcal: { low: 10000, best: 10000, high: 10000 } })).toBeNull();
  expect(entryRefusal({ ...big, kcal: { low: 99999, best: 99999, high: 99999 } })).toBe('That’s too much for one entry. Try a smaller amount.');
  expect(entryRefusal({ ...big, protein_g: { low: 500, best: 500, high: 500 } })).toBeNull();
  expect(entryRefusal({ ...big, protein_g: { low: 501, best: 501, high: 501 } })).toBe('That’s too much for one entry. Try a smaller amount.');
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

describe('F2 (rg4): an amount the table can\'t take shows the range on the row; nothing throws', () => {
  test.each(['0 roti', '5001 roti', '6000 roti'])('the edit sheet for %s draws, says the range and does not save', (txt) => {
    const it = parser.parse(txt).items[0];
    const onSave = jest.fn();
    let r!: ReactTestRenderer;
    act(() => { r = create(<EditSheet visible it={it} onClose={() => {}} onSave={onSave} onDelete={() => {}} />); });
    expect(textOf(r)).toContain('Enter an amount between 0.5 and 5,000.');
    const save = r.root.findAll((n) => n.props.title === 'Save changes')[0];
    expect(save.props.disabled).toBe(true);
    act(() => { save.props.onPress?.(); });
    expect(onSave).not.toHaveBeenCalled();
    act(() => { r.unmount(); });
  });
  test('Log "0 roti": no crash, the row says the range, nothing counted', async () => {
    const r = await mount(<Log />);
    await say(r, '0 roti');
    expect(textOf(r)).toContain('Enter an amount between 0.5 and 5,000.');
    // 0 kcal: the batch holds it as a choice (no one-tap Add), nothing is counted
    expect(r.root.findAll((n) => typeof n.props.onPress === 'function' && /^Add/.test(String(n.props.accessibilityLabel ?? '')))).toHaveLength(0);
    expect(saved()).toEqual([]);
  });
  test('Log "5001 roti" -> pick 5001: no crash, the range on the row, nothing saved', async () => {
    mockNav.mockClear();
    const r = await mount(<Log />);
    await say(r, '5001 roti');
    expect(textOf(r)).toMatch(/5001|5,001/);
    await press(r, /5,?001 pieces/, true);
    expect(textOf(r)).toContain('Enter an amount between 0.5 and 5,000.');
    expect(saved()).toEqual([]);
  });
  test('store guard mirrors Recompute: a table row with qty 0 or > 5000 is refused with the range', () => {
    const [roti] = parser.parse('2 roti').items;
    const e = entryFromItem({ ...roti, needs_confirmation: false }, { id: 'q', slot: 'lunch', raw_text: 'roti', local_date: today, tableVersion: DISH_TABLE_VERSION });
    expect(entryRefusal({ ...e, qty: 0 })).toBe('Enter an amount between 0.5 and 5,000.');
    expect(entryRefusal({ ...e, qty: 5001 })).toBe('Enter an amount between 0.5 and 5,000.');
    expect(entryRefusal({ ...e, qty: 5000, kcal: { low: 550000, best: 550000, high: 550000 } })).toBe('That’s too much for one entry. Try a smaller amount.');
    expect(entryRefusal({ ...e, qty: 90, kcal: { low: 9900, best: 9900, high: 9900 } })).toBeNull();
    // AI rows: the server's 0-5000 (food.go:969); typed rows 1-5000
    const ai = { ...e, dish_id: null, source: 'ai' as const, custom_name: 'wedding plate' };
    expect(entryRefusal({ ...ai, kcal: { low: 6000, best: 6000, high: 6000 } })).toBe('That’s too much for one entry. Try a smaller amount.');
    expect(entryRefusal({ ...ai, source: 'custom', kcal: { low: 6000, best: 6000, high: 6000 } })).toBe(TYPED_KCAL_REASON);
    expect(entryRefusal({ ...ai, kcal: { low: 5000, best: 5000, high: 5000 } })).toBeNull();
  });
});

describe('F3 (rg4): Review saves a confirmed 12 katori / 24 pieces; a needed choice is always shown', () => {
  async function reviewOf(text: string) {
    mockSaved = null;
    const r = await mount(<Review />);
    const items = parser.parse(text).items;
    await act(async () => { st.addEntries(items.map((it, i) => reviewEntry(it, { id: `rv${i}`, slot: 'lunch', raw_text: text, local_date: today, tableVersion: DISH_TABLE_VERSION }))); });
    return r;
  }
  const openAndSave = async (r: ReactTestRenderer, name: string) => {
    await press(r, new RegExp(`^Check: read as ${name},`));
    const sheet = r.root.findAll((n) => n.type === EditSheet && n.props.visible === true)[0];
    const save = sheet.findAll((n) => n.props.title === 'Save changes' && typeof n.props.onPress === 'function')[0];
    await act(async () => { save.props.onPress(); });
  };
  test('12 plate chole bhature: tap each card -> Save changes saves 12 katori (2,760) and 24 pieces (6,960)', async () => {
    const r = await reviewOf('12 plate chole bhature');
    await openAndSave(r, 'chole');
    expect(textOf(r)).not.toContain('Choose the type or amount first');
    await openAndSave(r, 'bhatura');
    expect(saved().map((e) => [e.dish_id, e.qty, e.unit, e.kcal.best]).sort()).toEqual([['bhatura', 24, 'count', 6960], ['chole', 12, 'katori', 2760]]);
  });
  test('a reading that truly needs a pick: the message comes with the choices on screen', async () => {
    const r = await reviewOf('12 plate chole bhature');
    const it = st.entries.find((e) => e.id === 'rv0')!.review_item!;
    const needsPick = { ...it, quantity: 12, unit: 'plate', needs_confirmation: false, unit_options: [{ qty: 12, unit: 'katori', kcal: 2760 }, { qty: 1, unit: 'katori', kcal: 230 }] } as never;
    const card = r.root.findAll((n) => typeof n.props.onResolve === 'function')[0];
    await act(async () => { card.props.onResolve(needsPick); });
    expect(textOf(r)).toContain('Not saved: Choose the type or amount first.');
    expect(textOf(r)).toMatch(/1 katori/); // the choice it points to is shown
    expect(saved()).toEqual([]);
  });
});
