// Designer (Oct 17): a pulled dish showed its raw id on Today ("Lunch · zarda_pulao") while Review showed its name. Every
// surface now uses ONE display-name source (domain.displayName / displayLabel): the dish table's name (bundled, else pulled),
// else the id as words ("Zarda pulao"). No dish label (text, accessibility label, chip label, sheet title) has a '_'.
// rg8 F-2 (CEO + Designer): custom names stay EXACTLY as typed ('akarsh_special_shake', 'iPhone shake'): excluded from the
// '_' check and asserted verbatim.
import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';

jest.mock('../src/lib/config', () => ({ config: { mock: true, mockAi: false }, flags: {} }));
let mockSaved: string | null = null;
jest.mock('../src/lib/kv', () => ({ kv: { get: async () => mockSaved, set: async (_k: string, v: string) => { mockSaved = v; } } }));
jest.mock('expo-crypto', () => ({ randomUUID: () => `id${Math.random()}` }));
jest.mock('expo-router', () => ({ useFocusEffect: () => {}, useRouter: () => ({ navigate: jest.fn(), push: jest.fn(), back: jest.fn(), replace: jest.fn() }), useLocalSearchParams: () => ({}) }));
jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual('react-native');
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});

import { StoreProvider } from '../src/lib/store';
import { displayLabel, displayName, entryFromItem, entryLabel, localDate, notMeasured, reopenRejected, type FoodEntry } from '../src/lib/domain';
import { adoptServer } from '../src/lib/serverRow';
import { DISH_TABLE_VERSION, parser, type Item } from '../src/parser';
import Today from '../src/app/(tabs)/index';
import Review from '../src/app/review';
import { EditSheet } from '../src/components/ItemEditor';
import { HeldRow } from '../src/components/LogRows';
import { VariantPickSheet } from '../src/components/VariantPickSheet';

jest.setTimeout(30_000);
const DAY = localDate();
const PULLED = { version: DISH_TABLE_VERSION + 2, units: { zarda_pulao: ['count', 'katori', 'spoon', 'plate', 'gram'] }, names: { zarda_pulao: 'zarda pulao' } };
// a reading that carries the slug as its name (what an older build stored before the name arrived)
const zarda = (): Item => ({ ...parser.unknown('zarda'), dish_id: 'zarda_pulao', name: 'zarda_pulao', matched_text: '1 katori zarda', source: 'table', data_source: 'table',
  ai_estimate: false, quantity: 1, unit: 'katori', kcal: { low: 320, best: 390, high: 470 }, protein_g: { low: 4, best: 5, high: 6.5 }, carbs_g: 72, fat_g: 9, needs_confirmation: false } as Item);
const opts = [{ dish_id: 'veg_pulao', name: 'veg pulao', kcal: 300, protein_g: 6 }, { dish_id: 'zarda_pulao', name: 'zarda_pulao', kcal: 390, protein_g: 5 }];
function entries(): FoodEntry[] {
  const o = (id: string, slot: FoodEntry['slot'] = 'lunch') => ({ id, slot, raw_text: '', local_date: DAY, tableVersion: DISH_TABLE_VERSION });
  return [
    { ...entryFromItem(zarda(), o('f', 'dinner')), custom_name: '', sync_error: 'server_error', server_failed: true }, // 5xx flag on Today
    reopenRejected({ ...entryFromItem(zarda(), o('v')), raw_text: '' }, 'variant_required', new Date(), opts), // Today review row + Review chips
    adoptServer({ ...entryFromItem(zarda(), o('n', 'snacks')), unit: 'glass' }, { state: 'needs_review', dish_id: 'zarda_pulao', qty: 1, unit: 'katori', kcal_best: 390 }), // unit note
    ...CUSTOM.map((name, i) => custom(`c${i}`, name)),
  ];
}
const CUSTOM = ['akarsh_special_shake', 'iPhone shake'];
function custom(id: string, name: string): FoodEntry {
  const now = new Date().toISOString();
  return { id, local_date: DAY, slot: 'breakfast', raw_text: name, dish_id: null, custom_name: name, qty: 1, unit: 'count', oil_level: '', kcal: { low: 150, best: 150, high: 150 },
    protein_g: { low: 5, best: 5, high: 5 }, source: 'custom', source_note: 'Your entry', confirmed: true, dish_table_version: DISH_TABLE_VERSION, created_at: now, updated_at: now, deleted_at: null,
    ...(name.includes('_') ? { sync_error: 'server_error', server_failed: true, server_counts: { kcal: 150, protein: 5 } } : {}) } as FoodEntry;
}
/** custom names are the user's own: never rewritten, so they are left out of the no-'_' check */
const notCustom = (x: string) => !CUSTOM.some((c) => x.includes(c));
/** every string the screen renders or announces */
function labels(r: ReactTestRenderer): string[] {
  const out: string[] = [];
  for (const n of r.root.findAll((x) => !!x.props)) {
    if (typeof n.type === 'string') { const cs = [n.props?.children].flat().filter((c) => typeof c === 'string' || typeof c === 'number'); if (cs.length) out.push(cs.join('')); }
    for (const k of ['accessibilityLabel', 'a11y', 'label', 'title']) if (typeof n.props?.[k] === 'string') out.push(n.props[k]);
  }
  return out;
}
async function screen(ui: React.ReactElement, pulled: boolean) {
  parser.setPulledUnits(null);
  mockSaved = JSON.stringify({ user: { id: 'u', name: 'A', email: 'a@x', idToken: null, mock: true }, entries: entries(), queue: [], aiQuota: { used: 0 }, ...(pulled ? { dishUnits: PULLED } : {}),
    profile: { goal: 'maintain', sex: 'm', age: 30, heightCm: 172, weightKg: 68, activity: 'light', diet: 'veg', kcalTarget: 2350, proteinTarget: 82, stepsTarget: 8000, addStepKcal: false, showKcalOnCards: true } });
  let r!: ReactTestRenderer;
  await act(async () => { r = create(<StoreProvider>{ui}</StoreProvider>); });
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
  return r;
}
afterEach(() => parser.setPulledUnits(null));

describe('one display-name source', () => {
  test('rg8 F-2: custom names are returned exactly as typed', () => {
    for (const n of CUSTOM) { expect(entryLabel({ custom_name: n, dish_id: null })).toBe(n); expect(displayName(n, null)).toBe(n); expect(displayLabel(n, null)).toBe(n); }
  });
  test('name present (pulled) and fallback (id as words); a slug never comes back', () => {
    parser.setPulledUnits(PULLED.units, PULLED.version, PULLED.names);
    expect(displayName('zarda_pulao', 'zarda_pulao')).toBe('zarda pulao');
    expect(displayLabel('', 'zarda_pulao')).toBe('Zarda pulao');
    expect(entryLabel({ custom_name: '', dish_id: 'zarda_pulao' })).toBe('Zarda pulao');
    expect(displayLabel('roti', 'roti')).toBe('Roti'); // bundled table name
    parser.setPulledUnits(null); // no name has arrived: the id as words, first letter capitalised
    expect(displayLabel('zarda_pulao', 'zarda_pulao')).toBe('Zarda pulao');
    expect(displayName('', 'kodo_millet_khichdi')).toBe('kodo millet khichdi');
    expect(entryLabel({ custom_name: 'my thali', dish_id: null })).toBe('my thali'); // rg8 F-2: the user's own name, verbatim
    expect(notMeasured('zarda_pulao', 'piece')).toBe('zarda pulao isn’t measured in pieces');
  });
  for (const pulled of [true, false]) {
    test(`Today, Review, edit sheet, type sheet, held row: "Zarda pulao", no '_' (${pulled ? 'name pulled' : 'fallback'})`, async () => {
      const all: string[] = [];
      const t = await screen(<Today />, pulled);
      const today = labels(t);
      expect(today.some((s) => s.includes('Dinner · Zarda pulao'))).toBe(true); // the 5xx row (was "Dinner · zarda_pulao")
      expect(today.some((s) => s.includes('Lunch · Zarda pulao'))).toBe(true); // the review row
      expect(today.some((s) => s.includes('zarda pulao isn’t measured in glasses'))).toBe(true); // the note
      all.push(...today); await act(async () => { t.unmount(); });
      const rv = await screen(<Review />, pulled);
      const review = labels(rv);
      expect(review.some((s) => s === 'Zarda pulao, 390 calories')).toBe(true);
      all.push(...review); await act(async () => { rv.unmount(); });
      let s!: ReactTestRenderer;
      await act(async () => { s = create(<><EditSheet visible it={zarda()} onClose={() => {}} onSave={() => {}} onDelete={() => {}} />
        <VariantPickSheet entry={entries()[1]} onPick={() => null} onClose={() => {}} /><HeldRow it={zarda()} onRemove={() => {}} /></>); });
      const sheets = labels(s);
      expect(sheets).toContain('zarda pulao'); // the sheet title
      expect(sheets.some((x) => x.startsWith('zarda pulao · 390 kcal'))).toBe(true);
      expect(sheets.some((x) => x.startsWith('Zarda pulao, 1 katori'))).toBe(true);
      all.push(...sheets); await act(async () => { s.unmount(); });
      expect(all.filter(notCustom).filter((x) => x.includes('_'))).toEqual([]);
      // custom names verbatim: no underscore rewrite, no capitalisation
      expect(today.some((x) => x.includes('Breakfast · akarsh_special_shake'))).toBe(true); // its 5xx row title
      expect(today.some((x) => x.includes('iPhone shake'))).toBe(true); // the plate summary
      expect(today.some((x) => /akarsh special shake|Akarsh|IPhone/.test(x))).toBe(false);
    });
  }
});
