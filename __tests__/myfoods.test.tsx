// Item 5, My foods (spec §6): create, the Mine tag in search, edit, clash, soft delete with Undo, kept in LocalStore, and
// logged rows that never change when the food is edited or deleted. Runs the real store (mock API, fake kv).
import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { TextInput } from 'react-native';

jest.mock('../src/lib/config', () => ({ config: { mock: true, mockAi: false, mockAiDelay: 0 }, flags: {} }));
let mockSaved: string | null = null;
jest.mock('../src/lib/kv', () => ({ kv: { get: async () => mockSaved, set: async (_k: string, v: string) => { mockSaved = v; } } }));
let mockN = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `id${++mockN}` }));
jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual('react-native');
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});
const mockBack = jest.fn(), mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ back: mockBack, push: mockPush }) }));

import { Store, StoreProvider, useStore } from '../src/lib/store';
import { CLASH_REASON, clashKey, clashOf, draftErrors, foodFromDraft, MyFood, newDraft, PROTEIN_BLANK_REASON, draftUnit } from '../src/features/myfoods/model';
import { buildEntries, compute, newTrayItem, recentFoods, searchAll, foodName } from '../src/features/logfood/model';
import { TYPED_KCAL_REASON } from '../src/lib/domain';
import { LogFoodScreen } from '../src/features/logfood/LogFoodScreen';
import { MyFoodsScreen } from '../src/features/myfoods/MyFoodsScreen';
import { NewFoodScreen } from '../src/features/myfoods/NewFoodScreen';

const T0 = new Date('2026-10-21T07:00:00Z');
const food = (name: string, o: Partial<MyFood> = {}): MyFood => ({ id: `f-${name}`, name, unit: 'piece', amount: 1, kcal: 180, protein: 7, created_at: T0.toISOString(), updated_at: T0.toISOString(), deleted_at: null, ...o });
const fill = (name: string, unit: 'piece' | 'bowl' | 'g' | 'ml', kcal: string, protein: string) => ({ ...draftUnit(newDraft(name), unit), kcal, protein });

describe('create', () => {
  test('a valid form makes a food: trimmed name, its own unit and amount, numbers per that amount', () => {
    const f = foodFromDraft({ ...fill('  Kokum   sherbet ', 'ml', '120', '0') }, [], { id: 'k1', now: T0 })!;
    expect(f).toMatchObject({ id: 'k1', name: 'Kokum sherbet', unit: 'ml', amount: 250, kcal: 120, protein: 0, deleted_at: null });
    expect(f.unitGrams).toBeUndefined();
  });
  test('protein starts blank and must be entered (0 is fine); kcal uses the typed-kcal limits', () => {
    expect(newDraft('x').protein).toBe('');
    expect(draftErrors(fill('Oats', 'bowl', '210', ''), []).protein).toBe(PROTEIN_BLANK_REASON);
    expect(draftErrors(fill('Oats', 'bowl', '210', '0'), [])).toEqual({});
    expect(draftErrors(fill('Oats', 'bowl', '0', '5'), []).kcal).toBe(TYPED_KCAL_REASON);
    expect(draftErrors(fill('Oats', 'bowl', '6000', '5'), []).kcal).toBe(TYPED_KCAL_REASON);
    expect(foodFromDraft(fill('Oats', 'bowl', '210', ''), [], { id: 'x' })).toBeNull();
  });
  test('grams in one piece add g as a unit; numbers scale from the food’s own amount', () => {
    const f = foodFromDraft({ ...fill('Besan chilla', 'piece', '180', '7'), unitGrams: '90' }, [], { id: 'b' })!;
    expect(f.unitGrams).toBe(90);
    const two = compute({ ...newTrayItem(f, 'k'), amount: 2 });
    expect([two.kcal, two.protein]).toEqual([360, 14]);
    const g = compute({ ...newTrayItem(f, 'k'), unit: 'g', amount: 45 });
    expect(g.kcal).toBe(90);
    const drink = compute({ ...newTrayItem(food('Kokum', { unit: 'ml', amount: 250, kcal: 120, protein: 0 }), 'k'), amount: 500 });
    expect(drink.kcal).toBe(240);
  });
});

describe('name clash (§6.5)', () => {
  test('lowercase, trim, collapsed spaces, hyphen as space; spelling differences are not merged', () => {
    const mine = [food('Besan chilla')];
    for (const n of ['Besan  Chilla', 'besan-chilla', ' besan chilla ', 'BESAN CHILLA']) expect(clashOf(n, mine)?.id).toBe('f-Besan chilla');
    expect(clashOf('Besan chila', mine)).toBeNull();
    expect(clashKey('Mom’s  poha-2')).toBe('mom’s poha 2');
  });
  test('a deleted food’s name can be reused; a table name never clashes; a food does not clash with itself', () => {
    expect(clashOf('Besan chilla', [food('Besan chilla', { deleted_at: T0.toISOString() })])).toBeNull();
    expect(clashOf('Roti', [])).toBeNull();
    const f = food('Besan chilla');
    expect(draftErrors(fill('besan chilla', 'piece', '200', '8'), [f], f.id)).toEqual({});
    expect(draftErrors(fill('besan chilla', 'piece', '200', '8'), [f]).name).toBe(CLASH_REASON);
  });
});

describe('search: Mine tag and ranking (§6.3)', () => {
  test('a loose Mine match ("chilla" in Ragi chilla) comes after exact table matches but before the other table results', () => {
    const r = searchAll('chilla', [food('Ragi chilla')]);
    const i = r.findIndex((x) => foodName(x) === 'Ragi chilla');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(r.slice(0, i).every((x) => 'aliases' in x && (x.name === 'chilla' || x.aliases.includes('chilla')))).toBe(true);
    expect(r.slice(i + 1).every((x) => 'aliases' in x)).toBe(true);
    expect(foodName(searchAll('ragi', [food('Ragi chilla')])[0])).toBe('Ragi chilla'); // prefix: first
    expect(foodName(searchAll('ragi chilla', [food('Ragi chilla')])[0])).toBe('Ragi chilla'); // exact: first
  });
  test('an exact or prefix Mine match beats the table; a loose Mine match never beats an exact table match', () => {
    expect(foodName(searchAll('roti', [food('Masala roti')])[0])).toBe('Roti');
    expect(foodName(searchAll('roti', [food('Masala roti')])[1])).toBe('Masala roti');
    expect(foodName(searchAll('roti', [food('Roti with ghee')])[0])).toBe('Roti with ghee');
    expect(searchAll('ragi', [food('Ragi chilla', { deleted_at: T0.toISOString() })]).some((x) => foodName(x) === 'Ragi chilla')).toBe(false);
  });
});

// ---------- the real store ----------
let st!: Store;
function Probe() { st = useStore(); return null; }
async function mount(ui: React.ReactElement) {
  let r!: ReactTestRenderer;
  await act(async () => { r = create(<StoreProvider><Probe />{ui}</StoreProvider>); });
  await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
  return r;
}
const byLabel = (r: ReactTestRenderer, l: string | RegExp) => r.root.findAll((x) => typeof x.props.onPress === 'function' && (typeof l === 'string' ? x.props.accessibilityLabel === l : l.test(String(x.props.accessibilityLabel ?? ''))));
const press = (r: ReactTestRenderer, l: string | RegExp) => { const m = byLabel(r, l); if (!m.length) throw new Error(`no ${l}`); return act(async () => { m[0].props.onPress(); }); };
const input = (r: ReactTestRenderer, l: RegExp) => r.root.findAll((x) => x.type === TextInput && l.test(String(x.props.accessibilityLabel ?? '')))[0];
const type = (r: ReactTestRenderer, l: RegExp, v: string) => act(async () => { input(r, l).props.onChangeText(v); });
const texts = (r: ReactTestRenderer) => r.root.findAll((n) => typeof n.type === 'string').flatMap((n) => [n.props.children].flat()).filter((c) => typeof c === 'string').join('');

beforeEach(() => { mockSaved = null; jest.clearAllMocks(); });

test('kept in LocalStore: saved, and back after a restart (offline)', async () => {
  let r = await mount(null as unknown as React.ReactElement);
  await act(async () => { st.saveMyFood(food('Besan chilla')); });
  await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
  expect(JSON.parse(mockSaved!).myFoods.map((f: MyFood) => f.name)).toEqual(['Besan chilla']);
  await act(async () => { r.unmount(); });
  r = await mount(null as unknown as React.ReactElement);
  expect(st.myFoods.map((f) => f.name)).toEqual(['Besan chilla']);
  await act(async () => { r.unmount(); });
});

test('past logged rows never change when the food is edited or deleted; Undo restores the food', async () => {
  const r = await mount(null as unknown as React.ReactElement);
  const f = food('Besan chilla');
  await act(async () => { st.saveMyFood(f); });
  const { entries } = buildEntries([{ ...newTrayItem(f, 'k'), amount: 2 }], T0, { now: T0, newId: () => 'row1' });
  await act(async () => { st.addEntries(entries); });
  const before = JSON.stringify(st.entries.find((e) => e.id === 'row1'));
  expect(JSON.parse(before)).toMatchObject({ custom_name: 'Besan chilla', kcal: { best: 360 }, protein_g: { best: 14 }, my_food_id: f.id, source: 'custom', display_unit: 'piece', display_amount: 2 });
  await act(async () => { st.saveMyFood({ ...f, name: 'Besan cheela', kcal: 250, protein: 10 }); });
  expect(JSON.stringify(st.entries.find((e) => e.id === 'row1'))).toBe(before);
  // Recent shows the food as it is now
  expect(recentFoods(st.entries, st.myFoods).map(foodName)).toEqual(['Besan cheela']);
  await act(async () => { st.deleteMyFood(f.id); });
  expect(JSON.stringify(st.entries.find((e) => e.id === 'row1'))).toBe(before);
  expect(recentFoods(st.entries, st.myFoods)).toEqual([]);
  expect(searchAll('besan', st.myFoods).some((x) => 'unit' in x && !('aliases' in x))).toBe(false);
  await act(async () => { st.restoreMyFood(f.id); });
  expect(st.myFoods[0]).toMatchObject({ name: 'Besan cheela', deleted_at: null });
  await act(async () => { r.unmount(); });
});

test('My foods screen: edit and Save; Delete food is immediate, toast "… deleted · Undo" restores it', async () => {
  const r = await mount(<MyFoodsScreen />);
  await act(async () => { st.saveMyFood(food('Besan chilla')); st.saveMyFood(food('Mom’s poha', { id: 'p', unit: 'bowl', kcal: 250 })); });
  expect(byLabel(r, 'Besan chilla, 1 piece, 180 kcal. Edit')).toHaveLength(1);
  await press(r, 'Besan chilla, 1 piece, 180 kcal. Edit');
  await type(r, /^Calories for 1 piece/, '200');
  await press(r, 'Save changes to besan chilla');
  expect(st.myFoods.find((f) => f.name === 'Besan chilla')!.kcal).toBe(200);
  await press(r, 'Besan chilla, 1 piece, 200 kcal. Edit');
  await press(r, 'Delete food, besan chilla. Past logs keep their values');
  expect(byLabel(r, /^Besan chilla, /)).toHaveLength(0);
  expect(texts(r)).toContain('Besan chilla deleted');
  expect(st.myFoods.find((f) => f.id === 'f-Besan chilla')!.deleted_at).not.toBeNull();
  await press(r, 'Undo delete');
  expect(st.myFoods.find((f) => f.id === 'f-Besan chilla')!.deleted_at).toBeNull();
  expect(byLabel(r, 'Besan chilla, 1 piece, 200 kcal. Edit')).toHaveLength(1);
  await act(async () => { r.unmount(); });
});

test('empty My foods: the line and an outlined New food', async () => {
  const r = await mount(<MyFoodsScreen />);
  expect(texts(r)).toContain('Foods you add show up here.');
  await press(r, 'New food');
  expect(mockPush).toHaveBeenCalledWith('/my-food-new');
  await act(async () => { r.unmount(); });
});

test('+ New food: a clash disables Save food; protein blank keeps it unsaved; Save food never touches the tray', async () => {
  const r = await mount(<NewFoodScreen />);
  await act(async () => { st.saveMyFood(food('Besan chilla')); });
  await type(r, /^Name, /, 'besan-chilla');
  expect(texts(r)).toContain(CLASH_REASON);
  const btn = r.root.findAll((x) => x.props.accessibilityLabel === 'Save food. Unavailable: you already have this food' && typeof x.props.onPress === 'function');
  expect(btn[0].props.disabled).toBe(true);
  await type(r, /^Name, /, 'Masala oats');
  await press(r, 'Bowl');
  await type(r, /^Calories for 1 bowl/, '210');
  await press(r, 'Save food. Saves masala oats to My foods');
  expect(texts(r)).toContain(PROTEIN_BLANK_REASON);
  expect(st.myFoods).toHaveLength(1);
  await type(r, /^Protein, grams/, '6');
  await press(r, 'Save food. Saves masala oats to My foods');
  expect(st.myFoods.map((f) => [f.name, f.unit, f.amount, f.kcal, f.protein])).toEqual([['Besan chilla', 'piece', 1, 180, 7], ['Masala oats', 'bowl', 1, 210, 6]]);
  expect(st.entries).toEqual([]);
  expect(mockBack).toHaveBeenCalled();
  await act(async () => { r.unmount(); });
});

test('Log food: No match → Add your own food → Save and add puts 1 unit in the tray; the food then shows with the Mine tag', async () => {
  const r = await mount(<LogFoodScreen />);
  await type(r, /^Search food$/, 'kokum sherbet');
  expect(texts(r)).toContain('No match for “kokum sherbet”');
  expect(texts(r)).toContain('Add your own food');
  expect(input(r, /^Name, /).props.value).toBe('Kokum sherbet');
  await press(r, 'Millilitres');
  await type(r, /^Calories for 250 ml/, '120');
  await type(r, /^Protein, grams/, '0');
  await press(r, 'Save and add. Saves kokum sherbet to My foods and adds 250 ml to the tray');
  expect(st.myFoods.map((f) => [f.name, f.unit, f.amount, f.kcal])).toEqual([['Kokum sherbet', 'ml', 250, 120]]);
  expect(byLabel(r, 'Log 1 item · 120 kcal')).toHaveLength(1);
  await type(r, /^Search food$/, 'kokum');
  expect(byLabel(r, 'Kokum sherbet, my food, 250 ml, 120 kcal. Open details')).toHaveLength(1);
  expect(texts(r)).toContain('Mine');
  await type(r, /^Search food$/, '');
  await press(r, 'Remove Kokum sherbet');
  await press(r, 'My foods');
  expect(mockPush).toHaveBeenCalledWith('/my-foods');
  await act(async () => { r.unmount(); });
});
