import fs from 'fs';
import path from 'path';
import { canAddEstimate, canConfirm, estimateAddLabel, plan, reviewRowKind, reviewSummary, ServerItem } from '../src/lib/confirmBatch';
import { reviewEntry, FoodEntry, entryFromItem, counted } from '../src/lib/domain';
import { parseLocal } from '../src/lib/parseLocal';
import { parser } from '../src/parser';

const ai = (name: string, k: number) => ({ ...parser.unknown(name), ai_estimate: true, source: 'ai_estimate' as const, dish_id: '',
  kcal: { low: k - 20, best: k, high: k + 30 }, needs_confirmation: true }) as ServerItem;
const o = (id: string) => ({ slot: 'lunch' as const, raw_text: 'x', local_date: '2026-10-16', tableVersion: 3, id });
const src = (f: string) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

describe('AI estimate row: own one-tap "Add · N kcal"', () => {
  test('label and eligibility', () => {
    expect(estimateAddLabel(ai('sushi', 1320))).toBe('Add · 1,320 kcal');
    expect(canAddEstimate(ai('sushi', 320))).toBe(true);
    expect(canAddEstimate({ ...ai('x', 0), kcal: { low: 0, best: 0, high: 0 } })).toBe(false);           // no kcal -> Enter kcal
    expect(canAddEstimate({ ...ai('x', 250), needs_input: true } as never)).toBe(false);                    // failed row
    expect(canAddEstimate({ ...ai('x', 250), flags: ['variant_choice'] })).toBe(false);                     // needs its pick
    expect(canAddEstimate({ ...ai('x', 250), flags: ['vague_quantity'] })).toBe(false);
    expect(canAddEstimate(parseLocal('2 roti').items[0])).toBe(false);                                      // table rows: not this button
  });
  test('Review: 3-item AI-only meal saves in exactly 3 taps; footer never adds them and disappears', () => {
    let rows: FoodEntry[] = [reviewEntry(ai('kombucha', 60), o('a')), reviewEntry(ai('sushi', 320), o('b')), reviewEntry(ai('hummus', 180), o('c'))];
    expect(rows.map((e) => reviewRowKind(e.review_item!))).toEqual(['estimate', 'estimate', 'estimate']);
    expect(reviewSummary(rows).button).toBeNull(); // footer never adds AI rows
    const saved: FoodEntry[] = []; let taps = 0;
    while (rows.length) {
      const e = rows[0]; taps++;
      const it = { ...e.review_item!, needs_confirmation: false };
      expect(canConfirm(it)).toBe(true); // store guard allows the explicit per-row confirm
      saved.push(entryFromItem(it, { ...o(e.id), raw_text: e.raw_text }));
      rows = rows.slice(1);
      expect(reviewSummary(rows).button).toBeNull();
    }
    expect(taps).toBe(3); expect(saved.map((e) => e.kcal.best)).toEqual([60, 320, 180]); expect(saved.every(counted)).toBe(true);
    expect(reviewSummary(rows)).toMatchObject({ button: null, stillText: '' });
  });
  test('Log: AI rows never in the batch; each row adds itself', () => {
    const p = plan([{ key: 'a', it: ai('kombucha', 60), confirmed: false }, { key: 'b', it: ai('sushi', 320), confirmed: false }, { key: 'c', it: ai('hummus', 180), confirmed: false }]);
    expect(p.add).toHaveLength(0); expect(p.primary).toBe(false);
    const log = src('src/app/(tabs)/log.tsx');
    expect(log).toMatch(/onAdd=\{\(n\) => addOne\(d, n\)\}/);
    expect(log).toMatch(/const addOne = \(d: Draft, n: Item\) => \{\n\s+if \(!canAddEstimate\(n\)\) return;\n\s+const no = st\.addEntries\(\[(?:withJob\()?entryFromItem/);
    expect(log).toMatch(/remove\(d\);\n\s+\};/);
  });
  test('styling: outlined, em (darker coral in light), never accentFill for this button', () => {
    const rows = src('src/components/LogRows.tsx');
    const i = rows.indexOf("kind === 'estimate' && canAddEstimate(it)"); const seg = rows.slice(i, rows.indexOf(') : (', i));
    expect(seg).toMatch(/borderColor: t\.c\.em/); expect(seg).toMatch(/tone="em"/); expect(seg).not.toMatch(/t\.c\.accentFill/);
    expect(src('src/app/review.tsx')).toMatch(/kind === 'estimate'\n\s+\? <OpenRow it=\{it\} kind="estimate"[^\n]*onAdd=\{\(n\) => tried\(e\.id, st\.confirmReview\(e\.id, n\)\)\}/);
  });
});
