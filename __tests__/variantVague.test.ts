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
    expect(variantOptions(base({ variant_options: [{ dish_id: 'x', name: 'x' } as never] }))).toEqual([]); // no kcal = not offered
    expect(kindOf(base({ flags: ['variant_choice'] }), false)).toBe('unit'); // flag without options still stays open
  });
  test('chip label', () => { expect(variantLabel('veg biryani', 'biryani')).toBe('Veg'); expect(variantLabel('moong chilla', 'chilla')).toBe('Moong'); expect(variantLabel('pulao', 'biryani')).toBe('Pulao'); });
});

describe('vague_quantity', () => {
  test('always needs a confirm, never batch, reason copy', () => {
    const v = base({ dish_id: 'dal', name: 'dal', flags: ['vague_quantity'], needs_confirmation: false, one_tap_ok: true });
    expect(oneTapOk(v)).toBe(false); expect(kindOf(v, false)).toBe('unit'); expect(kindOf(v, true)).toBe('counted');
    expect(reasonWord(v)).toBe('amount unclear');
    expect(plan([{ key: 'v', it: v, confirmed: false }]).add).toHaveLength(0);
  });
});

import { pickVague, scaleItem, vagueChoices, vagueWord } from '../src/lib/confirmBatch';
import { flush, Op } from '../src/lib/syncQueue';
import { reopenRejected, counted, FoodEntry } from '../src/lib/domain';

describe('vague_quantity How much? chips', () => {
  const v = base({ dish_id: 'dal', name: 'dal', unit: 'katori', quantity: 1, grams: 150, kcal: { low: 130, best: 150, high: 170 }, protein_g: { low: 7, best: 8, high: 9 }, flags: ['vague_quantity'], matched_text: 'dal' });
  test('open unit-style row, excluded from batch until picked', () => {
    expect(kindOf(v, false)).toBe('unit'); expect(plan([{ key: 'v', it: v, confirmed: false }]).add).toHaveLength(0);
  });
  test('Small / Usual / Large = 0.5x / 1x / 1.5x, none pre-selected', () => {
    const cs = vagueChoices(v, scaleItem);
    expect(cs.map((c) => [c.label, c.item.quantity, c.item.kcal.best])).toEqual([['Small', 0.5, 75], ['Usual', 1, 150], ['Large', 1.5, 225]]);
    const picked = pickVague(cs[2].item);
    expect(picked.flags).not.toContain('vague_quantity'); expect(picked.needs_confirmation).toBe(false); expect(kindOf(picked, true)).toBe('counted');
  });
  test('you wrote: actual word', () => {
    expect(vagueWord(v, 'thoda dal')).toBe('thoda'); expect(vagueWord(v, 'dal zyada')).toBe('zyada');
    expect(vagueWord({ ...v, vague_word: 'bahut' } as never, '')).toBe('bahut');
  });
});

describe('server rejects a save (4xx): row reopens for review', () => {
  const e = { id: 'e1', local_date: '2026-10-16', slot: 'lunch', raw_text: 'biryani', dish_id: 'chicken_biryani', custom_name: '', qty: 1, unit: 'plate', oil_level: '',
    kcal: { low: 275, best: 275, high: 275 }, protein_g: { low: 14, best: 14, high: 14 }, source: 'table', source_note: '', confirmed: true, dish_table_version: 3,
    created_at: '', updated_at: '', deleted_at: null } as FoodEntry;
  const sender = (status: number) => ({ upsertEntry: async () => { throw Object.assign(new Error('x'), { status }); }, deleteEntry: async () => {}, resolvePending: async () => null, deleteRemembered: async () => {} });
  test('422 / 400: op leaves the queue, entry returned as rejected (queue not blocked)', async () => {
    for (const st of [400, 422]) {
      const q: Op[] = [{ kind: 'upsert', entry: e, tries: 0 }, { kind: 'delete', id: 'z', tries: 0 }];
      const r = await flush(q, sender(st));
      expect(r.rejected.map((x) => x.entry.id)).toEqual(['e1']); expect(r.rest.some((o) => o.kind === 'upsert')).toBe(false);
    }
  });
  test('5xx / 429 keep the retry rule; a 409 is surfaced on the entry and never blocks the queue', async () => {
    for (const st of [500, 429]) { const r = await flush([{ kind: 'upsert', entry: e, tries: 0 }], sender(st)); expect(r.rejected).toEqual([]); expect(r.rest[0].tries).toBe(1); }
    const r = await flush([{ kind: 'upsert', entry: e, tries: 0 }], sender(409)); expect(r.rejected).toEqual([]); expect(r.rest).toEqual([]); expect(r.failed.map((f) => f.id)).toEqual([e.id]);
  });
  test('reopened entry is not counted and carries a review item', () => {
    const r = reopenRejected(e);
    expect(counted(r)).toBe(false); expect(r.needs_review).toBe(true); expect(r.kcal.best).toBe(0); expect(r.review_item?.needs_confirmation).toBe(true);
  });
});
