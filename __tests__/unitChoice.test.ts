// Hard gate: the kcal a row shows, the total, the Add/Confirm label and the saved entry all come from the
// same recomputed item for the selected unit.
import { parser, DISH_TABLE_VERSION, Item } from '../src/parser';
import { choose, unitChoices, unitKey, withUnit } from '../src/lib/decision';
import { draftTotals, logSummary } from '../src/lib/logSummary';
import { entryFromItem } from '../src/lib/domain';

const label = (items: Item[], toConfirm: number) => {
  const { kcal, protein } = draftTotals(items);
  return logSummary({ kcal, protein, items: items.length, estimating: 0, pending: 0, toConfirm, estimates: 0, needsKcal: 0 });
};
const save = (it: Item) => entryFromItem(it, { id: 'x', slot: 'dinner', raw_text: 't', local_date: '2026-10-15', tableVersion: DISH_TABLE_VERSION });
const roti = parser.parse('2 roti').items[0];

describe('momos: 8 plates vs 8 pieces', () => {
  const momos = parser.parse('8 plate momos').items[0];
  test('parsed as 8 plates, needs a decision, with a pieces alternative', () => {
    expect([momos.quantity, momos.unit, momos.needs_confirmation]).toEqual([8, 'plate', true]);
    expect(unitChoices(momos).map((c) => c.key)).toEqual(['8|piece', '8|plate']);
  });
  test('the highlighted option is the unit the shown kcal is computed for', () => {
    expect(unitKey(momos)).toBe('8|plate');
  });
  test.each([
    ['piece', '8|piece', 400],
    ['plate', '8|plate', 2400],
  ])('picking %s: row, total, button and saved entry agree', (unit, key, kcal) => {
    const it = choose(momos, key);
    expect([it.unit, it.kcal.best, it.needs_confirmation]).toEqual([unit, kcal, false]);
    const rows = [roti, it];
    const t = draftTotals(rows).kcal;
    expect(t).toBe(roti.kcal.best + kcal);
    expect(label(rows, 0).button).toBe(`Add ${t.toLocaleString('en-IN')} kcal`);
    const e = save(it);
    expect([e.qty, e.unit, e.kcal.best]).toEqual([8, unit, kcal]);
  });
  test('unconfirmed (nothing tapped): button confirms the plates reading it shows', () => {
    const rows = [roti, momos];
    const t = draftTotals(rows).kcal;
    expect(label(rows, 1).button).toContain(t.toLocaleString('en-IN'));
    expect(save(momos).kcal.best).toBe(momos.kcal.best);
  });
});

test('katori switch recomputes from the table and saves the same numbers', () => {
  const dal = parser.parse('2 katori dal').items[0];
  const one = withUnit(dal, 1, 'katori');
  expect(one.kcal.best).toBeCloseTo(dal.kcal.best / 2, 0);
  const rows = [one];
  expect(draftTotals(rows).kcal).toBe(one.kcal.best);
  expect(label(rows, 0).button).toBe(`Add ${one.kcal.best.toLocaleString('en-IN')} kcal`);
  expect([save(one).unit, save(one).kcal.best]).toEqual(['katori', one.kcal.best]);
});
