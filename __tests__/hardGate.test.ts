// Tester's hard-gate cases on 899f831: Review "All look right" confirmed default guesses.
import fs from 'fs';
import path from 'path';
import { bulkEligible, canConfirm, needsOwnPick, pickVague, pickVariant, plan, reviewBulk, scaleItem, vagueChoices, variantOptions, ServerItem } from '../src/lib/confirmBatch';
import { entryFromItem, reviewEntry, FoodEntry } from '../src/lib/domain';
import { variantField } from '../src/lib/api';
import { parseLocal } from '../src/lib/parseLocal';
import { parser } from '../src/parser';

const o = { slot: 'lunch' as const, local_date: '2026-10-16', tableVersion: 3 };
const rev = (text: string, id: string) => reviewEntry(parseLocal(text).items[0], { ...o, raw_text: text, id });
const failed = (): FoodEntry => reviewEntry({ ...parser.unknown('zorbali'), needs_input: true } as never, { ...o, raw_text: 'zorbali', id: 'f' });
const good = () => rev('2 roti', 'g'); // a confident item that ended up in review (e.g. late) stays bulk-confirmable

describe('Review bulk ("All look right") uses the Log batch rule', () => {
  test('case 1: open biryani row (default chicken 550) is excluded', () => {
    const b = rev('biryani', 'b');
    expect(b.review_item!.dish_id).toBe('chicken_biryani'); expect(needsOwnPick(b.review_item!)).toBe(true);
    expect(reviewBulk([b, good()]).map((e) => e.id)).toEqual(['g']);
  });
  test('case 2: thoda rice (vague) is excluded', () => {
    const r = rev('thoda rice', 'r');
    expect(reviewBulk([r]).length).toBe(0); expect(canConfirm(r.review_item!)).toBe(false);
  });
  test('case 3: failed AI / placeholder row with no real kcal (placeholder 250) is excluded', () => {
    const f = failed();
    expect(f.review_item!.kcal.best).toBeGreaterThan(0); // the placeholder number exists...
    expect(reviewBulk([f]).length).toBe(0); expect(canConfirm(f.review_item!)).toBe(false); // ...but never counts
  });
  test('Log batch and Review bulk agree item by item (single source)', () => {
    for (const t of ['biryani', 'thoda rice', '2 roti', '200g chicken breast grilled', 'sambar', 'amul masti buttermilk', 'chiken biryani', '1 katori dal']) {
      const it = parseLocal(t).items[0] as ServerItem; if (!it) continue;
      const logAdds = plan([{ key: 'k', it, confirmed: false }]).add.length === 1;
      const revAdds = reviewBulk([reviewEntry(it, { ...o, raw_text: t, id: 'x' })]).length === 1;
      expect([t, logAdds]).toEqual([t, revAdds]);
      expect([t, logAdds]).toEqual([t, bulkEligible(it)]);
    }
  });
  test('review.tsx uses reviewBulk for the button and its kcal', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/app/review.tsx'), 'utf8');
    expect(src).toMatch(/const sum = reviewSummary\(rows\);/); expect(src).toMatch(/sum\.bulk\.forEach\(\(e\) => confirmIt\(e\.id, e\.review_item!\)\)/);
  });
});

describe('store.confirmReview guard (canConfirm) + variant_dish_id only when picked', () => {
  test('unpicked variant / vague / placeholder rejected; picked ones accepted', () => {
    const b = parseLocal('biryani').items[0];
    expect(canConfirm(b)).toBe(false);
    const picked = pickVariant(b, variantOptions(b).find((v) => v.dish_id === 'veg_biryani')!);
    expect(canConfirm(picked)).toBe(true);
    const r = parseLocal('thoda rice').items[0];
    expect(canConfirm(r)).toBe(false); expect(canConfirm(pickVague(vagueChoices(r, scaleItem)[1].item))).toBe(true);
    expect(canConfirm(parser.unknown('zorbali'))).toBe(false);
    expect(fs.readFileSync(path.join(__dirname, '../src/lib/store.tsx'), 'utf8')).toMatch(/if \(!canConfirm\(it\)\) return \{ reason: CHOOSE_FIRST_REASON \};\n\s+if \(!hasKcal\(it\)\) return \{ reason: NO_KCAL_REASON \};/); // refused: the row stays in Review with the reason
  });
  test('variant_dish_id: sent for a pick or a named variant, never for the default guess', () => {
    const b = parseLocal('biryani').items[0];
    const guess = entryFromItem({ ...b, needs_confirmation: false }, { ...o, raw_text: 'biryani', id: 'a' });
    expect(guess.variant_dish_id).toBeUndefined(); expect(variantField(guess)).toEqual({});
    const pick = entryFromItem(pickVariant(b, variantOptions(b)[0]), { ...o, raw_text: 'biryani', id: 'b' });
    expect(variantField(pick)).toEqual({ variant_dish_id: pick.dish_id });
    const named = entryFromItem(parseLocal('1 plate veg biryani').items[0], { ...o, raw_text: '1 plate veg biryani', id: 'c' });
    expect(variantField(named)).toEqual({ variant_dish_id: 'veg_biryani' });
    const old = { ...named, variant_dish_id: undefined }; // entry from before this rule: server 422 -> picker
    expect(variantField(old)).toEqual({});
  });
});

describe('other one-tap paths', () => {
  test('server one_tap_ok=true never overrides an own-pick reason', () => {
    for (const t of ['biryani', 'thoda rice', '200g chicken breast grilled']) {
      const it = { ...parseLocal(t).items[0], one_tap_ok: true } as ServerItem;
      if (needsOwnPick(it)) expect(bulkEligible(it)).toBe(false);
    }
    expect(bulkEligible({ ...parser.unknown('x'), one_tap_ok: true } as ServerItem)).toBe(false);
  });
});

import { reviewSummary, reviewRowKind } from '../src/lib/confirmBatch';
describe('Review footer copy', () => {
  test('N counts only eligible rows; X still need you; rows keep their own pick row', () => {
    const rows = [good(), rev('biryani', 'b'), rev('thoda rice', 'r'), failed(), rev('chiken biryani', 'd')];
    const s = reviewSummary(rows);
    expect(s.bulk.map((e) => e.id)).toEqual(['g']);
    expect(s.button).toBe(`✓ All look right · Add ${Math.round(good().review_item!.kcal.best)} kcal`);
    expect(s.stillText).toBe('4 still need you');
    expect(reviewRowKind(rows[1].review_item!)).toBe('chips'); expect(reviewRowKind(rows[2].review_item!)).toBe('chips'); expect(reviewRowKind(rows[3].review_item!)).toBe('kcal');
  });
  test('zero eligible: no button at all', () => {
    const s = reviewSummary([rev('biryani', 'b'), failed()]);
    expect(s.button).toBeNull(); expect(s.stillText).toBe('2 still need you');
    expect(reviewSummary([rev('thoda rice', 'r')]).stillText).toBe('1 still needs you');
  });
  test('did_you_mean and AI estimate rows never bulk', () => {
    const dym = { ...parseLocal('2 roti').items[0], source: 'did_you_mean' as const, needs_confirmation: true, one_tap_ok: true };
    expect(bulkEligible(dym as ServerItem)).toBe(false);
    const ai = { ...parseLocal('2 roti').items[0], ai_estimate: true, source: 'ai_estimate' as const, dish_id: '' };
    expect(bulkEligible(ai as ServerItem)).toBe(false);
  });
  test('screen wiring: muted still-copy above the button, button only when eligible', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/app/review.tsx'), 'utf8');
    expect(src).toMatch(/sum\.stillText \? <T tone="muted">/); expect(src).toMatch(/sum\.button \? \(/);
    expect(src.indexOf('sum.stillText ?')).toBeLessThan(src.indexOf('sum.button ?'));
  });
});
