// Mirrors Go internal/parser/holdout_silent_test.go — silent wrong saves are a hard gate.
import { parser } from '../src/parser';

describe('Kurkure packet from brand label (holdout H13)', () => {
  test.each(['kurkure 1 packet', '1 packet kurkure', 'kurkure'])('%s', (text) => {
    const r = parser.parse(text);
    expect(r.items).toHaveLength(1);
    const it = r.items[0];
    expect(it.dish_id).toBe('kurkure');
    expect(it.needs_confirmation).toBe(false);
    expect(it.one_tap_ok).toBe(true);
    expect(it.source).toBe('table');
    expect(it.kcal.best).toBeGreaterThanOrEqual(126);
    expect(it.kcal.best).toBeLessThanOrEqual(176);
    expect(it.protein_g.best).toBeGreaterThanOrEqual(1.3);
    expect(it.protein_g.best).toBeLessThanOrEqual(2.9);
    expect(it.grams).toBeGreaterThanOrEqual(25);
    expect(it.grams).toBeLessThanOrEqual(35);
  });
});

describe('puttu kadala curry never silently drops kadala (holdout J03)', () => {
  test('puttu kadala curry', () => {
    const r = parser.parse('puttu kadala curry');
    expect(r.items).toHaveLength(2);
    const ids = r.items.map((it) => it.dish_id);
    expect(ids).toEqual(expect.arrayContaining(['puttu', 'kadala_curry']));
    let kcal = 0, prot = 0;
    for (const it of r.items) {
      expect(it.needs_confirmation).toBe(true);
      expect(it.one_tap_ok).toBe(false);
      const flags = it.flags ?? [];
      expect(flags.some((f) => f === 'compound_name' || f === 'leftover_in_meal' || f === 'leftover_nearby')).toBe(true);
      kcal += it.kcal.best;
      prot += it.protein_g.best;
    }
    expect(kcal).toBeGreaterThanOrEqual(342);
    expect(kcal).toBeLessThanOrEqual(616);
    expect(prot).toBeGreaterThanOrEqual(11);
    expect(prot).toBeLessThanOrEqual(23);
  });
});

describe('leftover unmatched words force confirmation', () => {
  test.each(['roti quinoa', '2 roti dal xyz', 'dal curry', 'puttu mystery side'])('%s', (text) => {
    const r = parser.parse(text);
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.leftover > 0 || (r.unmatched?.length ?? 0) > 0).toBe(true);
    for (const it of r.items) {
      expect(it.needs_confirmation).toBe(true);
      expect(it.one_tap_ok).toBe(false);
      const flags = it.flags ?? [];
      expect(flags.some((f) => f === 'leftover_in_meal' || f === 'leftover_nearby')).toBe(true);
    }
  });
});
