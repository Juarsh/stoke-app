// CEO / Designer (next build): the edit sheet hides the count chip on a dish that also comes in piece (roti and the like),
// the deferred "roti shows both count and piece chips". Checked first: in the dish table count and piece are the same thing
// for every one of the 128 dishes that have both (equal kcal low/best/high, protein, carbs, fat and grams at every amount),
// so they share ONE chip, labelled "piece". It is selected on a count row and tapping it keeps the row's own unit: a count
// row is never converted, the save is the same table reading, nothing changes on the server. Count alone reads "piece".
import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
jest.mock('react-native-safe-area-context', () => { const { View } = jest.requireActual('react-native'); return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }; });
import { EditSheet } from '../src/components/ItemEditor';
import { unitChips } from '../src/lib/labels';
import { parser, Item } from '../src/parser';

const item = (dish: string, qty: number, unit: string) => ({ ...parser.recompute(dish, qty, unit, ''), needs_confirmation: false } as Item);
const chipsOf = (t: ReactTestRenderer) => t.root.find((n) => n.props.testID === 'unit-chips' && typeof n.type !== 'string')
  .findAll((n) => typeof n.props.label === 'string' && typeof n.props.onPress === 'function' && n.props.kind === 'neutral');
afterEach(() => parser.setPulledUnits(null));

test('roti’s edit sheet shows one piece chip (no "count", no second pieces-type chip), selected for a count row', async () => {
  expect(parser.supportedUnits('roti')).toEqual(expect.arrayContaining(['count', 'piece']));
  for (const unit of ['count', 'piece']) {
    let t!: ReactTestRenderer;
    await act(async () => { t = create(<EditSheet visible it={item('roti', 2, unit)} onClose={() => {}} onSave={() => {}} onDelete={() => {}} />); });
    const chips = chipsOf(t);
    const labels = chips.map((c) => c.props.label as string);
    expect(labels.filter((l) => /^(piece|pieces|count)s?$/.test(l))).toEqual(['piece']);
    expect(chips.find((c) => c.props.label === 'piece')!.props.selected).toBe(true);
    await act(async () => { t.unmount(); });
  }
});

test('a count row for roti edits and saves at the right kcal, still in count (never converted)', async () => {
  const saved: Item[] = [];
  let t!: ReactTestRenderer;
  await act(async () => { t = create(<EditSheet visible it={item('roti', 2, 'count')} onClose={() => {}} onSave={(n) => saved.push(n)} onDelete={() => {}} />); });
  for (let i = 0; i < 2; i++) await act(async () => { t.root.find((n) => n.props.accessibilityLabel === 'Increase' && typeof n.props.onPress === 'function').props.onPress(); }); // step 0.5: 2 -> 3
  await act(async () => { chipsOf(t).find((c) => c.props.label === 'piece')!.props.onPress(); }); // the shared chip: stays count
  await act(async () => { t.root.find((n) => n.props.title === 'Save changes' && typeof n.props.onPress === 'function').props.onPress(); });
  expect(saved).toHaveLength(1);
  const want = parser.recompute('roti', 3, 'count', '');
  expect(saved[0]).toMatchObject({ dish_id: 'roti', quantity: 3, unit: 'count' });
  expect(saved[0].kcal.best).toBe(want.kcal.best); expect(saved[0].protein_g.best).toBe(want.protein_g.best);
  expect(saved[0].kcal.best).toBe(parser.recompute('roti', 3, 'piece', '').kcal.best); // and the same as 3 pieces in the table
  await act(async () => { t.unmount(); });
});

test('a dish whose only pieces-type unit is count still shows its chip, labelled "piece", and saves in count', async () => {
  parser.setPulledUnits({ roti: ['count', 'plate'] }); // e.g. a server list without piece
  expect(parser.supportedUnits('roti')).toEqual(['count', 'plate']);
  const saved: Item[] = [];
  let t!: ReactTestRenderer;
  await act(async () => { t = create(<EditSheet visible it={item('roti', 2, 'count')} onClose={() => {}} onSave={(n) => saved.push(n)} onDelete={() => {}} />); });
  const chips = chipsOf(t);
  expect(chips.map((c) => c.props.label)).toEqual(['piece', 'plate']);
  expect(chips[0].props.selected).toBe(true);
  await act(async () => { t.root.find((n) => n.props.title === 'Save changes' && typeof n.props.onPress === 'function').props.onPress(); });
  expect(saved[0]).toMatchObject({ unit: 'count', quantity: 2 }); expect(saved[0].kcal.best).toBe(parser.recompute('roti', 2, 'count', '').kcal.best);
  await act(async () => { t.unmount(); });
  expect(unitChips(['count'], 'count')).toEqual([{ unit: 'count', label: 'piece', selected: true }]);
});

test('unit sweep: every dish with both count and piece: same table reading at every amount, one chip, the row’s unit kept: 0 mismatches', () => {
  const both = parser.allDishes().filter((d) => parser.supportedUnits(d.id).includes('count') && parser.supportedUnits(d.id).includes('piece'));
  expect(both.length).toBeGreaterThan(100);
  const bad: string[] = [];
  for (const d of both) {
    for (const q of [0.25, 0.5, 1, 1.5, 2, 3, 7, 12, 25, 100]) {
      const a = parser.recompute(d.id, q, 'count', ''), b = parser.recompute(d.id, q, 'piece', '');
      for (const k of ['grams', 'carbs_g', 'fat_g'] as const) if (a[k] !== b[k]) bad.push(`${d.id} ${q} ${k}`);
      for (const k of ['low', 'best', 'high'] as const) { if (a.kcal[k] !== b.kcal[k]) bad.push(`${d.id} ${q} kcal.${k}`); if (a.protein_g[k] !== b.protein_g[k]) bad.push(`${d.id} ${q} protein.${k}`); }
    }
    for (const cur of ['count', 'piece']) {
      const cs = unitChips(parser.supportedUnits(d.id), cur);
      if (cs.some((c) => c.label === 'count')) bad.push(`${d.id} count chip shown`);
      if (cs.filter((c) => c.label === 'piece').length !== 1) bad.push(`${d.id} piece chips`);
      const sel = cs.filter((c) => c.selected);
      if (sel.length !== 1 || sel[0].unit !== cur) bad.push(`${d.id} selected for ${cur}: ${JSON.stringify(sel)}`);
    }
  }
  expect(bad).toEqual([]);
  // dishes without piece: chips unchanged
  for (const d of parser.allDishes().filter((x) => !parser.supportedUnits(x.id).includes('piece')))
    expect(unitChips(parser.supportedUnits(d.id), d.unit).map((c) => c.unit)).toEqual(parser.supportedUnits(d.id).map((u) => (u === d.unit ? d.unit : u)));
});
