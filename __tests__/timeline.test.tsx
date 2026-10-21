// Item 6, Food timeline (spec §4, Q10, Q12): 45-minute blocks, totals equal Home's, edit through the item sheet
// (recalculates, same row and sync path), remove with Undo, past My food rows keep their snapshot, flagged rows stay flagged.
import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';

jest.mock('../src/lib/config', () => ({ config: { mock: true, mockAi: false, mockAiDelay: 0 }, flags: {} }));
let mockSaved: string | null = null;
jest.mock('../src/lib/kv', () => ({ kv: { get: async () => mockSaved, set: async (_k: string, v: string) => { mockSaved = v; } } }));
let mockN = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `id${++mockN}` }));
jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual('react-native');
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn(), push: mockPush }) }));

import { Store, StoreProvider, useStore } from '../src/lib/store';
import { counted, dayOf, dayTotals, FoodEntry } from '../src/lib/domain';
import { DISHES } from '../src/parser';
import { buildEntries, compute, newTrayItem, stepAmount } from '../src/features/logfood/model';
import type { MyFood } from '../src/features/myfoods/model';
import { foodCard } from '../src/features/home/model';
import { blocks, entryFromEdit, trayFromEntry } from '../src/features/timeline/model';
import { TimelineScreen } from '../src/features/timeline/TimelineScreen';

const NOW = new Date('2026-10-21T14:00:00Z'); // 7:30 PM IST
const ist = (hhmm: string) => new Date(`2026-10-21T${hhmm}:00+05:30`);
const dish = (name: string) => DISHES.find((d) => d.name.toLowerCase() === name)!;
let n = 0;
const row = (name: string, at: Date, amount?: number, extra: Partial<FoodEntry> = {}): FoodEntry => {
  const d = dish(name); const t = newTrayItem(d, 'k');
  const e = buildEntries([amount ? { ...t, amount } : t], at, { now: NOW, newId: () => `e${++n}` }).entries[0];
  return { ...e, server_version: 1, ...extra };
};
const mine: MyFood = { id: 'f1', name: 'Besan chilla', unit: 'piece', amount: 1, kcal: 180, protein: 7, created_at: NOW.toISOString(), updated_at: NOW.toISOString(), deleted_at: null };

let st!: Store;
function Probe() { st = useStore(); return null; }
async function mount(entries: FoodEntry[], extra: object = {}) {
  mockSaved = JSON.stringify({ user: { id: 'u', name: 'A', email: 'a@x', idToken: 't', mock: true }, profile: { kcalTarget: 2100, proteinTarget: 60, diet: 'veg' },
    entries, steps: {}, queue: [], aiQuota: { used: 0 }, ...extra });
  let r!: ReactTestRenderer;
  await act(async () => { r = create(<StoreProvider><Probe /><TimelineScreen now={() => NOW} /></StoreProvider>); });
  await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
  return r;
}
const byLabel = (r: ReactTestRenderer, l: string | RegExp) => r.root.findAll((x) => typeof x.props.onPress === 'function' && (typeof l === 'string' ? x.props.accessibilityLabel === l : l.test(String(x.props.accessibilityLabel ?? ''))));
const press = (r: ReactTestRenderer, l: string | RegExp) => { const m = byLabel(r, l); if (!m.length) throw new Error(`no ${l}`); return act(async () => { m[0].props.onPress(); }); };
const texts = (r: ReactTestRenderer) => r.root.findAll((x) => typeof x.type === 'string').flatMap((x) => [x.props.children].flat()).filter((c) => typeof c === 'string').join('|');
const eaten = (r: ReactTestRenderer) => r.root.findAll((x) => x.props.testID === 'tl-eaten' && typeof x.type === 'string')[0].props.children;
const live = () => st.entries.filter((e) => counted(e) && e.local_date === dayOf(NOW));

beforeEach(() => { mockSaved = null; n = 0; jest.clearAllMocks(); });

describe('blocks (45-minute rule)', () => {
  test('45:00 apart joins the block, 46 minutes starts a new one; the chain follows the previous entry', () => {
    const e = [row('roti', ist('08:00')), row('dal', ist('08:45')), row('rice', ist('09:31')), row('dal', ist('10:15')), row('roti', ist('13:00'))];
    const b = blocks(e);
    expect(b.map((x) => x.entries.length)).toEqual([2, 2, 1]);
    expect(b[0].kcal).toBe(Math.round(e[0].kcal.best + e[1].kcal.best));
  });
  test('order is by eaten-at time, not by when it was logged', () => {
    const late = row('roti', ist('13:00')), early = row('dal', ist('08:00'));
    expect(blocks([late, early]).map((x) => x.entries[0].id)).toEqual([early.id, late.id]);
  });
});

test('the day total is Home’s total (same entries, same sum) and the blocks add up to it', async () => {
  const e = [row('roti', ist('08:10'), 3), row('dal', ist('08:20')), row('rice', ist('13:15')), row('roti', ist('03:30'))]; // 3:30 AM: yesterday
  const r = await mount(e);
  const home = foodCard(live(), 2100, 60);
  expect(eaten(r)).toBe(home.eaten.toLocaleString('en-IN'));
  expect(home.eaten).toBe(dayTotals(e.slice(0, 3)).kcal);
  expect(blocks(live()).reduce((s, b) => s + b.kcal, 0)).toBe(home.eaten);
  expect(texts(r)).toContain('Wed 21 Oct · Today');
  expect(texts(r)).toContain(`${(2100 - home.eaten).toLocaleString('en-IN')} left`);
  await press(r, 'Previous day');
  expect(texts(r)).toContain('Tue 20 Oct · Yesterday');
  expect(eaten(r)).toBe(Math.round(e[3].kcal.best).toLocaleString('en-IN'));
  await act(async () => { r.unmount(); });
});

test('empty day: 0 of target, one card, reset line, outlined Log food', async () => {
  const r = await mount([]);
  expect(eaten(r)).toBe('0');
  expect(texts(r)).toContain('Nothing logged yet');
  expect(texts(r)).toContain('Your day resets at 4 AM.');
  expect(byLabel(r, 'Log food')).toHaveLength(2);
  await act(async () => { r.unmount(); });
});

test('edit: tap the row, the item sheet in Update mode, more → recalculates; same row id through the edit path', async () => {
  const roti = row('roti', ist('08:10'), 2);
  const r = await mount([roti]);
  await press(r, /Open$/);
  await press(r, new RegExp(`^Roti, 2 .*${Math.round(roti.kcal.best)} calories\\. Edit$`));
  expect(byLabel(r, /^When: 8:10 AM\. Change$/)).toHaveLength(1);
  await press(r, 'More');
  await press(r, /^Update Roti/);
  const after = st.entries.find((e) => e.id === roti.id)!;
  expect(st.entries.filter((e) => !e.deleted_at)).toHaveLength(1);
  expect(after.display_amount).toBe(3);
  expect(after.kcal.best).toBeCloseTo(roti.kcal.best * 1.5, 0);
  expect(after.eaten_at).toBe(roti.eaten_at);
  expect(eaten(r)).toBe(Math.round(after.kcal.best).toLocaleString('en-IN'));
  await act(async () => { r.unmount(); });
});

test('an edit keeps the server’s flags: a row the server hasn’t confirmed keeps counting what the server has', () => {
  const old = row('roti', ist('08:10'), 2, { server_failed: true, server_counts: { kcal: 100, protein: 3 } });
  const r = entryFromEdit(old, stepAmount(trayFromEntry(old), 1), new Date(old.eaten_at!), NOW);
  expect(r.entry).toMatchObject({ id: old.id, server_version: 1, server_failed: true, server_counts: { kcal: 100, protein: 3 } });
  // nothing changed: nothing is saved
  expect(entryFromEdit(old, trayFromEntry(old), new Date(old.eaten_at!), NOW).entry).toBeNull();
});

test('remove (✕) is a soft delete with Undo; Undo brings the same row back and the total with it', async () => {
  const roti = row('roti', ist('08:10'), 2), dal = row('dal', ist('08:20'));
  const r = await mount([roti, dal]);
  const before = eaten(r);
  await press(r, /Open$/);
  await press(r, 'Remove Dal');
  expect(st.entries.find((e) => e.id === dal.id)!.deleted_at).toBeTruthy();
  expect(eaten(r)).toBe(Math.round(roti.kcal.best).toLocaleString('en-IN'));
  expect(st.undoToast?.text).toBe('Removed Dal');
  await act(async () => { st.undoToast!.undo(); });
  expect(eaten(r)).toBe(before);
  const back = live().filter((e) => e.dish_id === dal.dish_id);
  expect(back).toHaveLength(1);
  expect(back[0].kcal).toEqual(dal.kcal);
  await act(async () => { r.unmount(); });
});

test('Undo after the delete already reached the server: comes back as a new row with the same numbers', async () => {
  const dal = row('dal', ist('08:20'));
  const r = await mount([{ ...dal, deleted_at: NOW.toISOString() }]);
  await act(async () => { st.restoreEntry(dal.id); });
  const back = live();
  expect(back).toHaveLength(1);
  expect(back[0].id).not.toBe(dal.id);
  expect(back[0].kcal).toEqual(dal.kcal);
  expect(back[0].server_version).toBeUndefined();
  await act(async () => { r.unmount(); });
});

test('a past My food row keeps its own numbers after the food is edited, also when opened and changed', async () => {
  const logged = { ...buildEntries([{ ...newTrayItem(mine, 'k'), amount: 2 }], ist('08:10'), { now: NOW, newId: () => 'm1' }).entries[0], server_version: 1 };
  const r = await mount([logged], { myFoods: [{ ...mine, kcal: 250, protein: 9 }] }); // the food was edited after logging
  expect(eaten(r)).toBe('360');
  const t = trayFromEntry(st.entries[0]);
  expect(compute(t).kcal).toBe(360);
  const three = entryFromEdit(st.entries[0], stepAmount(t, 1), ist('08:10'), NOW).entry!;
  expect([three.kcal.best, three.protein_g.best, three.my_food_id, three.source]).toEqual([540, 21, 'f1', 'custom']);
  await act(async () => { r.unmount(); });
});

test('moving a block moves every item by the same amount (all-or-nothing)', async () => {
  const a = row('roti', ist('08:10')), b = row('dal', ist('08:30'));
  const r = await mount([a, b]);
  await press(r, /^8:10 AM\. Change time for 2 items$/);
  expect(texts(r)).toContain('Moves all 2 items together.');
  await press(r, /^1 hr ago/); // 6:30 PM
  const got = st.entries.map((e) => new Date(e.eaten_at!).toISOString());
  expect(got).toEqual([new Date(NOW.getTime() - 3600000).toISOString(), new Date(NOW.getTime() - 3600000 + 20 * 60000).toISOString()]);
  await act(async () => { r.unmount(); });
});
