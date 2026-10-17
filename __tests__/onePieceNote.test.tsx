// Designer (next build): on a piece reading the "sources vary" note reads exactly "That’s {n} kcal for one piece. Change the
// amount if yours is bigger or smaller." (curly apostrophe; {n} = the kcal for ONE piece, in the shared kcal format), replacing
// "Published recipes give … kcal a piece. Check it matches your piece." Other units keep their line.
import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
jest.mock('react-native-safe-area-context', () => { const { View } = jest.requireActual('react-native'); return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }; });
import { OpenRow } from '../src/components/LogRows';
import { onePieceNote } from '../src/lib/labels';
import { kc } from '../src/lib/format';
import { parser, Item } from '../src/parser';

const item = (dish: string, qty: number, unit: string) => ({ ...parser.recompute(dish, qty, unit, ''), needs_confirmation: true } as Item);
const flat = (x: unknown): string => (Array.isArray(x) ? x.map(flat).join('') : x == null || typeof x === 'boolean' ? '' : typeof x === 'object' ? flat((x as { props?: { children?: unknown } }).props?.children) : String(x));
async function note(it: Item) {
  let t!: ReactTestRenderer;
  await act(async () => { t = create(<OpenRow it={it} kind="unverified" onConfirm={() => {}} onEdit={() => {}} onRemove={() => {}} />); });
  const n = t.root.find((x) => x.props.testID === 'sources-vary' && typeof x.type !== 'string');
  const s = flat(n.props.children);
  await act(async () => { t.unmount(); });
  return s;
}

test('exact copy, curly apostrophe, shared kcal format (Indian grouping, rounded)', () => {
  expect(onePieceNote(110, 1)).toBe('That’s 110 kcal for one piece. Change the amount if yours is bigger or smaller.');
  expect(onePieceNote(2400, 2)).toBe('That’s 1,200 kcal for one piece. Change the amount if yours is bigger or smaller.');
  expect(onePieceNote(250, 3)).toBe(`That’s ${kc(250 / 3)} kcal for one piece. Change the amount if yours is bigger or smaller.`);
  expect(onePieceNote(250, 3)).toContain('That’s 83 kcal');
  expect(onePieceNote(200000, 1)).toContain('That’s 2,00,000 kcal');
  expect(onePieceNote(110, 1)).not.toContain("'");
});

test('a roti row (count, 2) says the kcal for ONE piece; a piece row too; no "kcal a piece", no "Check it matches"', async () => {
  for (const [unit, qty] of [['count', 2], ['piece', 2], ['count', 1], ['piece', 3]] as const) {
    const it = item('roti', qty, unit);
    const s = await note(it);
    expect(s).toBe(`That’s ${kc(it.kcal.best / qty)} kcal for one piece. Change the amount if yours is bigger or smaller.`);
    expect(s).not.toMatch(/kcal a |Check it matches|count/);
  }
  expect(await note(item('roti', 2, 'count'))).toBe(`That’s ${kc(parser.recompute('roti', 1, 'count', '').kcal.best)} kcal for one piece. Change the amount if yours is bigger or smaller.`);
});

test('other units keep the published-range line', async () => {
  const it = item('dal', 1, 'katori');
  expect(await note(it)).toBe(`Published recipes give ${kc(it.kcal.low)}–${kc(it.kcal.high)} kcal a katori. Check it matches your katori.`);
});
