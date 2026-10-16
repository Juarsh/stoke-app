import { kindOf, oneTapOk, pickVariant, plan, variantOptions, isVariantChoice, ServerItem } from '../src/lib/confirmBatch';
import { reasonWord } from '../src/lib/learned';
import { variantLabel } from '../src/components/LogRows';

const base = (o: Partial<ServerItem> & Record<string, unknown> = {}): ServerItem => ({
  dish_id: 'chicken_biryani', name: 'biryani', matched_text: 'biryani', quantity: 1, unit: 'plate', grams: 300, oil_level: '',
  kcal: { low: 230, best: 275, high: 420 }, protein_g: { low: 6, best: 14, high: 22 }, carbs_g: 40, fat_g: 10, source: 'table', data_source: '',
  source_note: '', fuzzy: false, needs_confirmation: true, default_portion: false, span_start: 0, span_end: 7, ai_estimate: false, ...o,
} as ServerItem);
const opts = [{ dish_id: 'veg_biryani', name: 'veg biryani', kcal: 230, protein_g: 6 }, { dish_id: 'chicken_biryani', name: 'chicken biryani', kcal: 275, protein_g: 14 }];

describe('variant_choice', () => {
  const it = base({ flags: ['variant_choice'], variant_options: opts, one_tap_ok: true });
  test('open row, never batch, never one-tap even if server says so', () => {
    expect(isVariantChoice(it)).toBe(true); expect(oneTapOk(it)).toBe(false); expect(kindOf(it, false)).toBe('unit');
    const p = plan([{ key: 'a', it, confirmed: false }, { key: 'b', it: base({ dish_id: 'roti', name: 'roti', needs_confirmation: false, kcal: { low: 100, best: 120, high: 140 } }), confirmed: false }]);
    expect(p.add.map((r) => r.key)).toEqual(['b']); expect(p.open.map((r) => r.key)).toEqual(['a']); expect(p.kcal).toBe(120);
  });
  test('default chicken dish_id is never saved without a pick: only the picked variant counts', () => {
    const v = pickVariant(it, variantOptions(it)[0]);
    expect(v.dish_id).toBe('veg_biryani'); expect(v.kcal).toEqual({ low: 230, best: 230, high: 230 }); expect(v.protein_g.best).toBe(6);
    expect(v.flags).not.toContain('variant_choice'); expect(isVariantChoice(v)).toBe(false); expect(kindOf(v, true)).toBe('counted');
  });
  test('tolerant of field names', () => {
    for (const k of ['variant_options', 'variants', 'variant_choices']) {
      const x = base({ [k]: [{ id: 'veg_biryani', label: 'veg biryani', kcal: { best: 230 }, protein: 6 }] });
      expect(variantOptions(x)).toEqual([{ dish_id: 'veg_biryani', name: 'veg biryani', kcal: 230, protein_g: 6 }]);
      expect(kindOf(x, false)).toBe('unit');
    }
    expect(variantOptions(base({ variant_options: [{ dish_id: 'x', name: 'x' }] }))).toEqual([]); // no kcal = not offered
    expect(kindOf(base({ flags: ['variant_choice'] }), false)).toBe('unit'); // flag without options still stays open
  });
  test('chip label', () => { expect(variantLabel('veg biryani', 'biryani')).toBe('Veg'); expect(variantLabel('moong chilla', 'chilla')).toBe('Moong'); expect(variantLabel('pulao', 'biryani')).toBe('Pulao'); });
});

describe('vague_quantity', () => {
  test('always needs a confirm, never batch, reason copy', () => {
    const v = base({ dish_id: 'dal', name: 'dal', flags: ['vague_quantity'], needs_confirmation: false, one_tap_ok: true });
    expect(oneTapOk(v)).toBe(false); expect(kindOf(v, false)).toBe('choice'); expect(kindOf(v, true)).toBe('counted');
    expect(reasonWord(v)).toBe('amount unclear');
    expect(plan([{ key: 'v', it: v, confirmed: false }]).add).toHaveLength(0);
  });
});
