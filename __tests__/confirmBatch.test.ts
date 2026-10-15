import { kindOf, oneTapOk, plan, ServerItem } from '../src/lib/confirmBatch';
import { parser } from '../src/parser';

const base = (o: Partial<ServerItem>): ServerItem => ({ ...parser.parse('2 roti').items[0], needs_confirmation: true, source: 'did_you_mean', ...o });
const r = (it: ServerItem, key = it.name, confirmed = false) => ({ key, it, confirmed });

describe('one_tap_ok guard', () => {
  test('missing field is false (never derived from flags in the app)', () => {
    const it = base({ flags: [], confidence: 1 }); delete (it as { one_tap_ok?: boolean }).one_tap_ok;
    expect(oneTapOk(it)).toBe(false); expect(kindOf(it, false)).toBe('choice');
    expect(oneTapOk(base({ one_tap_ok: false }))).toBe(false);
  });
  test('server true on a plain table item -> batchable', () => { expect(oneTapOk(base({ one_tap_ok: true }))).toBe(true); });
  test.each([
    ['unit_mismatch (unit_options)', { unit_options: [{ qty: 8, unit: 'piece', kcal: 400 }, { qty: 8, unit: 'plate', kcal: 2400 }] }],
    ['unit_mismatch (flag only)', { flags: ['unit_mismatch'] }],
    ['AI estimate', { ai_estimate: true, source: 'ai_estimate' }],
    ['estimate_unverified', { flags: ['estimate_unverified'] }],
  ] as [string, Partial<ServerItem>][])('never batch %s, even if the server says one_tap_ok', (_n, o) => {
    const it = base({ one_tap_ok: true, ...o });
    expect(oneTapOk(it)).toBe(false);
    expect(['unit', 'estimate', 'unverified']).toContain(kindOf(it, false));
    const p = plan([r(it)]);
    expect(p.add).toHaveLength(0); expect(p.kcal).toBe(0); expect(p.disabled).toBe(true);
  });
});

describe('batch plan (numbers from the API item)', () => {
  const roti = base({ name: 'roti', one_tap_ok: true, kcal: { low: 200, best: 240, high: 280 } });
  const dal = base({ name: 'dal', one_tap_ok: true, kcal: { low: 120, best: 150, high: 180 } });
  const thukpa = base({ name: 'thukpa', ai_estimate: true, source: 'ai_estimate', one_tap_ok: true, kcal: { low: 220, best: 290, high: 380 } });
  test('confirm batch: N marked items added, others open and not counted', () => {
    const p = plan([r(roti), r(dal), r(thukpa)]);
    expect(p.button).toBe('Confirm 2 · 1 still needs a choice');
    expect(p.total).toBe('Total · 1 still needs a choice');
    expect(p.kcal).toBe(390); expect(p.note).toBe('Adds 390 kcal. Thukpa stays open.');
    expect(p.open.map((x) => x.key)).toEqual(['thukpa']);
  });
  test('plural: still need', () => {
    expect(plan([r(roti), r(thukpa, 'a'), r({ ...thukpa, name: 'momos' }, 'b')]).button).toBe('Confirm 1 · 2 still need a choice');
  });
  test('none one-tap: disabled "Choose for each item to add it", 0 kcal', () => {
    const p = plan([r({ ...roti, one_tap_ok: undefined }), r(thukpa)]);
    expect(p).toMatchObject({ button: 'Choose for each item to add it', disabled: true, kcal: 0, total: 'Total · 2 need a choice' });
  });
  test('nothing open: "Add N kcal"; confirmed AI estimate counts', () => {
    expect(plan([r(roti), r(thukpa, 't', true)]).button).toBe('Add 530 kcal');
  });
});

import { pickUnit } from '../src/lib/confirmBatch';
test('unit_mismatch: options from unit_options, nothing preselected/counted, picked option saves its kcal', () => {
  const momos = parser.parse('8 plates momos').items[0] as ServerItem;
  expect(momos.unit_options?.length).toBeGreaterThanOrEqual(2);
  expect(kindOf(momos, false)).toBe('unit');
  expect(plan([r(momos)]).kcal).toBe(0);
  for (const o of momos.unit_options!) {
    const it = pickUnit(momos, o);
    expect([it.quantity, it.unit, it.kcal.best, it.unit_options]).toEqual([o.qty, o.unit, o.kcal, undefined]);
    expect(kindOf(it, true)).toBe('counted');
  }
});
test('bhel puri (estimate_unverified) is never confident or batched', () => {
  const b = parser.parse('bhel puri').items[0] as ServerItem;
  expect(b.flags).toContain('estimate_unverified');
  expect(kindOf({ ...b, one_tap_ok: true }, false)).toBe('unverified');
});
