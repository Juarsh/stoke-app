// Rg10 note (CEO, next build): 'count' is the server's unit name, never a word in user copy. It reads "piece" / "pieces"
// ("Saved as 2 pieces", "dal isn’t measured in pieces", unit chips, "Did you mean … or pieces?", "kcal a piece").
import { adoptServer, reviewNote } from '../src/lib/serverRow';
import { entryFromItem, FoodEntry, notMeasured, unitPlural, unitReason, localDate } from '../src/lib/domain';
import { portionLabel, unitWord } from '../src/lib/labels';
import { editNotSaved } from '../src/lib/store';
import { parser, DISH_TABLE_VERSION, Item } from '../src/parser';

const DAY = localDate();
const tableEntry = (id: string, dish: string, qty: number, unit: string): FoodEntry => {
  const it = { ...parser.recompute(dish, qty, unit, ''), needs_confirmation: false } as Item;
  return { ...entryFromItem(it, { id, slot: 'lunch', raw_text: `${qty} ${unit} ${dish}`, local_date: DAY, tableVersion: DISH_TABLE_VERSION }), qty, unit };
};
const COUNT_WORD = /\bcounts?\b/i;

describe('count is never a word in user copy', () => {
  test('unitWord / portionLabel / unitPlural', () => {
    expect([unitWord('count'), unitWord('count', true), unitWord('katori'), unitWord('plate', true)]).toEqual(['piece', 'pieces', 'katori', 'plate']);
    expect([portionLabel(2, 'count'), portionLabel(1, 'count'), unitPlural('count')]).toEqual(['2 pieces', '1 piece', 'pieces']);
  });
  test('"Saved as" on a row the server stored with another amount: "Saved as 2 pieces · 220 kcal." (never "2 count")', () => {
    const e = tableEntry('A', 'roti', 3, 'count');
    const n = adoptServer(e, { version: 2, state: 'confirmed', dish_id: 'roti', qty: 2, unit: 'count', kcal_best: 220, protein_best: 7 });
    expect(n.server_note).toBe('Saved as 2 pieces · 220 kcal.'); expect(n.server_note).not.toMatch(COUNT_WORD);
    const one = adoptServer(e, { version: 2, state: 'confirmed', dish_id: 'roti', qty: 1, unit: 'count', kcal_best: 110, protein_best: 3 });
    expect(one.server_note).toBe('Saved as 1 piece · 110 kcal.');
    const kat = adoptServer(tableEntry('B', 'dal', 2, 'katori'), { version: 2, state: 'confirmed', dish_id: 'dal', qty: 1, unit: 'katori', kcal_best: 150, protein_best: 5 });
    expect(kat.server_note).toBe('Saved as 1 katori · 150 kcal.');
  });
  test('"isn’t measured in pieces" for count (was "by count"), in review notes and unit reasons', () => {
    expect(notMeasured('dal', 'count')).toBe('dal isn’t measured in pieces');
    expect(unitReason('count', 'dal')).not.toMatch(COUNT_WORD);
    const e = { ...tableEntry('C', 'dal', 1, 'katori'), unit: 'count' } as FoodEntry;
    expect(reviewNote(e)).not.toMatch(COUNT_WORD); expect(reviewNote(e)).toContain('pieces');
  });
  test('the refused-delete note names the amount in unit words', () => {
    expect(editNotSaved(portionLabel(3, 'count'))).toBe('Your change to 3 pieces wasn’t saved. Edit it again if you still want it.');
  });
});

// screens: the edit sheet's unit chips and the Log row copy
import React from 'react';
import { act, create } from 'react-test-renderer';
jest.mock('react-native-safe-area-context', () => { const { View } = jest.requireActual('react-native'); return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }; });
import { EditSheet } from '../src/components/ItemEditor';
test('edit sheet: roti’s count chip reads "pieces", never "count"', async () => {
  const it = { ...parser.recompute('roti', 2, 'count', ''), needs_confirmation: false } as Item;
  let t!: ReturnType<typeof create>;
  await act(async () => { t = create(<EditSheet visible it={it} onClose={() => {}} onSave={() => {}} onDelete={() => {}} />); });
  const chips = t.root.findAll((n) => n.props.testID === 'unit-chips' && typeof n.type !== 'string');
  const labels = chips.length ? chips[0].findAll((n) => typeof n.props.label === 'string' && typeof n.props.onPress === 'function').map((n) => n.props.label as string) : [];
  expect(labels.length).toBeGreaterThan(0);
  expect(labels).toContain('pieces'); expect(labels).not.toContain('count');
  const all = t.root.findAll((n) => typeof n.type === 'string').flatMap((n) => [n.props.children].flat()).filter((c) => typeof c === 'string').join(' ');
  expect(all).not.toMatch(/\b\d+ count\b|\bcount\b/);
  await act(async () => { t.unmount(); });
});
