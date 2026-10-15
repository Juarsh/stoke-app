// Counting units + plausible counts (mirrors Go internal/parser/units_test.go and compound_test.go).
import { parser, totals } from '../src/parser';

describe('a bare number means the counting unit', () => {
  test.each([['8 momos', 'piece', 8], ['4 idli', 'count', 4], ['2 samosa', 'count', 2], ['3 roti', 'count', 3]] as const)('%s', (text, unit, qty) => {
    const r = parser.parse(text);
    expect(r.items).toHaveLength(1);
    const it = r.items[0];
    expect([it.unit, it.quantity, it.source, it.needs_confirmation]).toEqual([unit, qty, 'table', false]);
    expect(it.unit_options ?? []).toHaveLength(0);
    expect(totals(r.items)[0].best).toBe(it.kcal.best);
  });
  test('8 momos is pieces, never plates', () => expect(parser.parse('8 momos').items[0].kcal.best).toBeLessThanOrEqual(600));
});

describe('a count that does not fit its unit is unit_mismatch, with options, out of totals', () => {
  test.each([['8 plates momos', ['piece', 'plate']], ['6 katori dal', ['katori']]] as const)('%s', (text, units) => {
    const r = parser.parse(text);
    const it = r.items[0];
    expect(it.flags).toContain('unit_mismatch');
    expect(it.needs_confirmation).toBe(true);
    expect(it.source).not.toBe('table');
    expect((it.unit_options ?? []).length).toBeGreaterThanOrEqual(2);
    for (const u of units) expect(it.unit_options!.some((o) => o.unit === u && o.qty === it.quantity && o.kcal > 0)).toBe(true);
    expect(totals(r.items)[0].best).toBe(0);
  });
  test('8 plates momos offers 8 pieces and 8 plates', () => {
    const o = parser.parse('8 plates momos').items[0].unit_options!;
    expect(o.find((x) => x.unit === 'piece')!.kcal).toBeLessThan(o.find((x) => x.unit === 'plate')!.kcal);
  });
});

describe('valid units per dish', () => {
  test.each([['2 dal', 'katori', 300], ['1 plate idli', 'plate', 120]] as const)('%s is valid and confirmed', (text, unit, kcal) => {
    const it = parser.parse(text).items[0];
    expect([it.unit, it.source, it.needs_confirmation, it.kcal.best]).toEqual([unit, 'table', false, kcal]);
    expect(it.flags ?? []).not.toContain('unit_mismatch');
  });
});

describe('compound names never split into confident items', () => {
  test.each(['egg rice', 'chicken rice', '2 paneer roti', '1 plate chicken pulao', 'dal chai'])('%s', (text) => {
    for (const it of parser.parse(text).items) { expect(it.source).not.toBe('table'); expect(it.needs_confirmation).toBe(true); }
  });
  test.each(['idli aur sambar', '2 roti, 1 katori dal', 'roti sabzi', 'idli sambar'])('%s is not compound', (text) => {
    for (const it of parser.parse(text).items) expect(it.flags ?? []).not.toContain('compound_name');
  });
  test('trailing quantity stops at aur', () => {
    const r = parser.parse('poha 1 plate aur chai');
    expect(r.items.find((i) => i.dish_id === 'chai')!.unit).toBe('count');
  });
});

describe('estimate_unverified dishes are never confident (Go estimate_unverified_test.go)', () => {
  test.each(['bhel puri', '1 plate bhel puri', '2 roti, 1 bhel puri'])('%s', (text) => {
    const b = parser.parse(text).items.filter((it) => it.dish_id === 'bhel_puri');
    expect(b.length).toBeGreaterThan(0);
    for (const it of b) { expect(it.needs_confirmation).toBe(true); expect(it.source).not.toBe('table'); expect(it.flags).toContain('estimate_unverified'); }
  });
  test('recompute keeps it unconfirmed', () => {
    const it = parser.recompute('bhel_puri', 1, 'plate', 'normal');
    expect(it.needs_confirmation).toBe(true);
  });
});

describe('one_tap_ok (Go TestOneTapOK)', () => {
  test.each([['2 roti', 'roti', true], ['1 katori dal', 'dal', true], ['8 plates momos', 'momos', false],
    ['1 plate bhel puri', 'bhel_puri', false], ['2 rotti', 'roti', false]] as [string, string, boolean][])('%s', (text, dish, want) => {
    const it = parser.parse(text).items.find((x) => x.dish_id === dish)!;
    expect(it.one_tap_ok).toBe(want);
    if (it.one_tap_ok) { expect(it.needs_confirmation).toBe(false); expect(it.source).toBe('table'); }
  });
  test('compound names are never one-tap', () => {
    for (const it of parser.parse('chicken rice').items) expect(it.one_tap_ok).toBe(false);
  });
});
