// Log food S2.1 (item 4): search ranking, units / stepper, edited values, tray totals, "Log N items" with the chosen time,
// and the 4 AM day start. Every number is the dish table's (parser.recompute); nothing new.
import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { TextInput } from 'react-native';
import { dayOf, dayTotals, entryRefusal, slotOf, TYPED_KCAL_REASON } from '../src/lib/domain';
import { parser } from '../src/parser';
import {
  buildEntries, canStepDown, chipLabel, compute, defaultUnit, editKcal, editProtein, FUTURE_REASON, newTrayItem, quickAdd, resetEdits,
  searchFoods, setUnit, stepAmount, TOO_OLD_REASON, trayCount, trayTotal, timeReason, uiUnits, wheelTime, TrayItem,
} from '../src/features/logfood/model';

const mockStore = { entries: [] as unknown[], newId: (() => { let n = 0; return () => `id${n++}`; })(), addEntries: jest.fn(() => []), showUndo: jest.fn(), deleteEntry: jest.fn() };
const mockBack = jest.fn(), mockPush = jest.fn();
jest.mock('@/lib/store', () => ({ useStore: () => mockStore }));
jest.mock('expo-router', () => ({ useRouter: () => ({ back: mockBack, push: mockPush }) }));
jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual('react-native');
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});
import { LogFoodScreen } from '../src/features/logfood/LogFoodScreen';

const D = (id: string) => parser.dishById(id)!;
const ist = (s: string) => new Date(`${s}+05:30`);
let k = 0; const key = () => `k${++k}`;
let n = 0; const newId = () => `e${++n}`;

describe('search', () => {
  test('exact name first, then name prefix, then word prefix; shorter names first', () => {
    const ids = searchFoods('roti').map((d) => d.id);
    expect(ids[0]).toBe('roti');
    expect(ids).toContain('tandoori_roti');
    expect(searchFoods('rice')[0].id).toBe('rice');
    expect(searchFoods('dal')[0].id).toBe('dal');
  });
  test('aliases find the food; case and spaces do not matter; empty finds nothing', () => {
    expect(searchFoods('chapati')[0].id).toBe('roti');
    expect(searchFoods('  ROTI ')[0].id).toBe('roti');
    expect(searchFoods('')).toEqual([]);
    expect(searchFoods('zzzz')).toEqual([]);
  });
  test('generic and unverified-estimate rows are never offered (no AI or guess rows, Q3)', () => {
    const all = ['chicken', 'paneer', 'egg', 'bhel', 'wrap'].flatMap((q) => searchFoods(q, undefined, 100));
    expect(all.some((d) => d.needs_confirm || d.estimate_unverified)).toBe(false);
  });
});

describe('units and amounts', () => {
  test('piece / bowl / g / ml only, default first (§5.3)', () => {
    expect(uiUnits(D('roti'))).toEqual(['piece', 'g']);
    expect(uiUnits(D('dal'))).toEqual(['bowl', 'g']);
    expect(uiUnits(D('chai'))).toEqual(['ml', 'g']);
    for (const d of searchFoods('a', undefined, 500)) for (const u of uiUnits(d)) expect(['piece', 'bowl', 'g', 'ml']).toContain(u);
  });
  test('a unit change recalculates kcal and protein from the table', () => {
    const t = newTrayItem(D('roti'), key(), 'piece', 2);
    const c = compute(t), r = parser.recompute('roti', 2, 'count', '');
    expect([c.kcal, c.protein]).toEqual([r.kcal.best, r.protein_g.best]);
    const g = setUnit(t, 'g');
    expect(g).toMatchObject({ unit: 'g', amount: Math.round(D('roti').portion_grams) });
    const cg = compute(g), rg = parser.recompute('roti', g.amount, 'gram', '');
    expect([cg.kcal, cg.protein, cg.grams]).toEqual([rg.kcal.best, rg.protein_g.best, rg.grams]);
    const dal = setUnit(newTrayItem(D('dal'), key()), 'g');
    expect(compute({ ...dal, amount: 300 }).kcal).toBe(parser.recompute('dal', 300, 'gram', 'normal').kcal.best);
  });
  test('stepper: piece 1, bowl ½, g 25, ml 50; − disabled at the minimum (Q13)', () => {
    const p = newTrayItem(D('roti'), key());
    expect(stepAmount(p, 1).amount).toBe(2);
    expect(canStepDown(p)).toBe(false);
    expect(stepAmount(p, -1)).toBe(p);
    const b = newTrayItem(D('dal'), key());
    expect(stepAmount(b, 1).amount).toBe(1.5);
    expect(stepAmount(b, -1).amount).toBe(0.5);
    expect(canStepDown({ unit: 'bowl', amount: 0.5 })).toBe(false);
    expect(stepAmount({ ...b, unit: 'g', amount: 150 }, 1).amount).toBe(175);
    expect(stepAmount({ ...b, unit: 'g', amount: 150 }, -1).amount).toBe(125);
    expect(stepAmount({ key: 'c', dishId: 'chai', unit: 'ml', amount: 150 }, 1).amount).toBe(200);
  });
  test('quick + adds the default amount; the same food again adds to its row (×N)', () => {
    let tray: TrayItem[] = [];
    tray = quickAdd(tray, D('roti'), key());
    tray = quickAdd(tray, D('roti'), key());
    tray = quickAdd(tray, D('dal'), key());
    expect(tray.map((x) => [x.dishId, x.unit, x.amount])).toEqual([['roti', 'piece', 2], ['dal', 'bowl', 1]]);
    expect(trayCount(tray, D('roti'))).toBe(2);
    expect(defaultUnit(D('chai'))).toBe('ml');
  });
});

describe('edited values', () => {
  test('typed kcal is kept exactly, scales with the amount, keeps its mark; protein stays computed', () => {
    const dal = newTrayItem(D('dal'), key());
    const e = editKcal(dal, 170);
    expect(compute(e)).toMatchObject({ kcal: 170, kcalEdited: true, proteinEdited: false });
    const two = stepAmount(stepAmount(e, 1), 1); // 2 bowls
    expect(compute(two).kcal).toBe(340);
    expect(compute(two).protein).toBe(parser.recompute('dal', 2, 'katori', 'normal').protein_g.best);
    expect(compute(resetEdits(two)).kcal).toBe(parser.recompute('dal', 2, 'katori', 'normal').kcal.best);
  });
  test('Log saves an edited value exactly as typed, flagged, as the user’s own number', () => {
    const t = editProtein(editKcal(newTrayItem(D('roti'), key(), 'piece', 2), 213), 7.5);
    const { entries, refused } = buildEntries([t], ist('2026-10-21T13:10:00'), { newId });
    expect(refused).toEqual([]);
    expect(entries[0]).toMatchObject({ kcal: { best: 213 }, protein_g: { best: 7.5 }, kcal_edited: true, protein_edited: true, source: 'custom', dish_id: null, custom_name: 'Roti',
      display_amount: 2, display_unit: 'piece' });
    // carbs and fat stay computed
    expect(entries[0].carbs_g).toBe(parser.recompute('roti', 2, 'count', '').carbs_g);
    const p = buildEntries([editProtein(newTrayItem(D('dal'), key()), 18)], new Date(), { newId }).entries[0];
    expect(p.protein_edited).toBe(true); expect(p.kcal_edited).toBeUndefined();
  });
  test('nothing saves a wrong number: an edit over the gate refuses the whole log (all-or-nothing)', () => {
    const ok = newTrayItem(D('roti'), key());
    const bad = editKcal(newTrayItem(D('dal'), key()), 6000);
    const r = buildEntries([ok, bad], new Date(), { newId });
    expect(r.entries).toEqual([]);
    expect(r.refused).toEqual([{ key: bad.key, reason: TYPED_KCAL_REASON }]);
  });
});

describe('tray and Log', () => {
  test('tray total equals the sum of its rows, and the day total of what is saved', () => {
    const tray = [newTrayItem(D('roti'), key(), 'piece', 2), newTrayItem(D('dal'), key(), 'bowl', 1.5), editKcal(newTrayItem(D('rice'), key()), 240)];
    const sum = tray.reduce((s, t) => s + compute(t).kcal, 0);
    expect(trayTotal(tray).kcal).toBe(Math.round(sum));
    const { entries } = buildEntries(tray, new Date(), { newId });
    expect(dayTotals(entries).kcal).toBe(trayTotal(tray).kcal);
  });
  test('"Log N items" makes N rows at the chosen time; table rows pass the store gate unchanged', () => {
    const at = ist('2026-10-21T19:45:00');
    const tray = [newTrayItem(D('roti'), key(), 'piece', 2), newTrayItem(D('dal'), key()), newTrayItem(D('chai'), key())];
    const { entries } = buildEntries(tray, at, { newId });
    expect(entries).toHaveLength(3);
    for (const e of entries) {
      expect(e.eaten_at).toBe(at.toISOString());
      expect(e.local_date).toBe('2026-10-21');
      expect(e.slot).toBe('dinner');
      expect(entryRefusal(e)).toBeNull();
    }
    expect(entries.map((e) => [e.dish_id, e.unit, e.qty, e.source])).toEqual([['roti', 'count', 2, 'table'], ['dal', 'katori', 1, 'table'], ['chai', 'gram', 120, 'table']]);
    expect(new Set(entries.map((e) => e.id)).size).toBe(3);
  });
});

describe('time and the 4 AM day start', () => {
  test('00:00–03:59 counts towards the day before; 04:00 starts the new day', () => {
    expect(dayOf(ist('2026-10-21T01:00:00'))).toBe('2026-10-20');
    expect(dayOf(ist('2026-10-21T03:59:00'))).toBe('2026-10-20');
    expect(dayOf(ist('2026-10-21T04:00:00'))).toBe('2026-10-21');
    expect(dayOf(ist('2026-10-21T23:59:00'))).toBe('2026-10-21');
    const { entries } = buildEntries([newTrayItem(D('roti'), key())], ist('2026-10-21T01:30:00'), { newId });
    expect(entries[0].local_date).toBe('2026-10-20');
    expect(slotOf(ist('2026-10-21T08:00:00'))).toBe('breakfast');
  });
  test('chip label (Q31), future refused, more than 7 days back refused', () => {
    const now = ist('2026-10-21T20:15:00');
    expect(chipLabel({ kind: 'now' }, now)).toBe('Now');
    expect(chipLabel({ kind: 'ago', min: 30 }, now)).toBe('7:45 PM');
    expect(chipLabel({ kind: 'at', iso: ist('2026-10-20T19:45:00').toISOString() }, now)).toBe('Yesterday 7:45 PM');
    expect(chipLabel({ kind: 'at', iso: ist('2026-10-19T08:05:00').toISOString() }, now)).toBe('Mon 8:05 AM');
    // 1 AM today belongs to yesterday's log day
    expect(chipLabel({ kind: 'at', iso: ist('2026-10-21T01:00:00').toISOString() }, now)).toBe('Yesterday 1:00 AM');
    expect(timeReason(ist('2026-10-21T20:30:00'), now)).toBe(FUTURE_REASON);
    expect(timeReason(ist('2026-10-14T20:00:00'), now)).toBe(TOO_OLD_REASON);
    expect(timeReason(ist('2026-10-14T20:30:00'), now)).toBeNull();
    expect(wheelTime('2026-10-20', 8, 45, true).toISOString()).toBe(ist('2026-10-20T20:45:00').toISOString());
    expect(wheelTime('2026-10-20', 12, 5, false).toISOString()).toBe(ist('2026-10-20T00:05:00').toISOString());
  });
});

describe('screen', () => {
  const press = (r: ReactTestRenderer, label: RegExp | string) => {
    const m = r.root.findAll((x) => typeof x.props.onPress === 'function' && (typeof label === 'string' ? x.props.accessibilityLabel === label : label.test(String(x.props.accessibilityLabel ?? ''))));
    if (!m.length) throw new Error(`no ${label}`);
    return act(async () => { m[0].props.onPress(); });
  };
  const search = (r: ReactTestRenderer, q: string) => act(async () => {
    r.root.findAll((x) => x.type === TextInput && x.props.accessibilityLabel === 'Search food')[0].props.onChangeText(q);
  });
  test('search, quick +, ×N, tray, then "Log 2 items" saves 2 rows at the chosen time', async () => {
    const now = ist('2026-10-21T20:15:00');
    let r!: ReactTestRenderer;
    await act(async () => { r = create(<LogFoodScreen now={() => now} />); });
    expect(r.root.findAll((x) => x.props.accessibilityLabel === 'Log food' && x.props.accessibilityState?.disabled === true).length).toBeGreaterThan(0);
    await search(r, 'roti');
    await press(r, 'Add 1 piece roti');
    await press(r, /^Roti, in tray, 1 piece, add more$/);
    expect(r.root.findAll((x) => /^Roti, in tray, 2 pieces/.test(String(x.props.accessibilityLabel ?? ''))).length).toBeGreaterThan(0);
    await search(r, 'dal');
    await press(r, 'Add 1 bowl dal');
    const total = Math.round(compute(newTrayItem(D('roti'), 'a', 'piece', 2)).kcal + compute(newTrayItem(D('dal'), 'b')).kcal);
    const label = `Log 2 items · ${total.toLocaleString('en-IN')} kcal`;
    expect(r.root.findAll((x) => x.props.accessibilityLabel === label).length).toBeGreaterThan(0);
    await press(r, /^When: Now/);
    await press(r, /^30 min ago/);
    await press(r, label);
    expect(mockStore.addEntries).toHaveBeenCalledTimes(1);
    const saved = (mockStore.addEntries.mock.calls[0] as unknown as [{ eaten_at: string; dish_id: string; qty: number }[]])[0];
    expect(saved.map((e) => [e.dish_id, e.qty])).toEqual([['roti', 2], ['dal', 1]]);
    expect(saved.every((e) => e.eaten_at === ist('2026-10-21T19:45:00').toISOString())).toBe(true);
    expect(mockStore.showUndo).toHaveBeenCalledWith(`Logged 2 items · ${total.toLocaleString('en-IN')} kcal`, expect.any(Function));
    expect(mockBack).toHaveBeenCalled();
    await act(async () => { r.unmount(); });
  });
  test('the sheet: stepper and a typed kcal; Add puts it in the tray marked edited', async () => {
    let r!: ReactTestRenderer;
    await act(async () => { r = create(<LogFoodScreen />); });
    await search(r, 'dal');
    await press(r, /^Dal, 1 bowl, .* Open details$/);
    await press(r, 'More');
    await press(r, /^Calories, \d+\. Edit$/);
    const input = r.root.findAll((x) => x.type === TextInput && /^Calories, /.test(String(x.props.accessibilityLabel)))[0];
    await act(async () => { input.props.onChangeText('9000'); });
    await press(r, /^Add 1½ dal/);
    expect(r.root.findAll((x) => x.props.children === TYPED_KCAL_REASON).length).toBeGreaterThan(0); // refused, sheet stays
    await act(async () => { r.root.findAll((x) => x.type === TextInput && /^Calories, /.test(String(x.props.accessibilityLabel)))[0].props.onChangeText('255'); });
    await press(r, /^Add 1½ dal/);
    await search(r, '');
    expect(r.root.findAll((x) => x.props.accessibilityLabel === 'Dal, 1½ bowls, 255 kcal, calories edited. Edit').length).toBeGreaterThan(0);
    await act(async () => { r.unmount(); });
  });
});
