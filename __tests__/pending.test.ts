import { parser } from '../src/parser';
import { fillPending, resolvePending, splitBySpan } from '../src/lib/pending';
import { counted, FoodEntry, pendingEntry, toReview } from '../src/lib/domain';
import { enqueue, flush, Op, PendingFood } from '../src/lib/syncQueue';
import { logSummary } from '../src/lib/logSummary';
import { ParsePending, parseJobBody } from '../src/lib/api';

const ai = (name: string, kcal: number) => ({ ...parser.parse('dal').items[0], dish_id: '', name, matched_text: name, source: 'ai_estimate' as const,
  ai_estimate: true, needs_confirmation: true, kcal: { low: kcal - 50, best: kcal, high: kcal + 50 } });
const food = (id = 'p1', at?: number): PendingFood => ({ id, span: 'egg bhurji', slot: 'lunch', local_date: '2026-10-12', raw_text: 'egg bhurji', at });

/** Simulates the store around an Add tap: Add queues a pending placeholder (+ its pending op) for the estimating span. */
function tapAdd(entries: FoodEntry[], queue: Op[], f: PendingFood) {
  const ph = pendingEntry(f);
  let q = enqueue(queue, { kind: 'upsert', entry: ph, tries: 0 });
  q = enqueue(q, { kind: 'pending', food: f, tries: 0 });
  return { entries: [...entries, ph], queue: q };
}

describe('AI answer racing the Add tap (stable item id)', () => {
  test('answer just BEFORE the tap: nothing is queued yet, fillPending is a no-op (Log shows it as a draft instead)', () => {
    const r = fillPending([], [], 'p1', [ai('egg bhurji', 260)]);
    expect(r.changed).toBe(false); expect(r.entries).toEqual([]);
  });
  test('answer just AFTER the tap: fills the same review item, unconfirmed, no duplicate', () => {
    const s = tapAdd([], [], food('p1', 0));
    const r = fillPending(s.entries, s.queue, 'p1', [ai('egg bhurji', 260)]);
    expect(r.changed).toBe(true);
    expect(r.entries).toHaveLength(1);
    const e = r.entries[0];
    expect(e.id).toBe('p1'); expect(e.needs_review).toBe(true); expect(e.confirmed).toBe(false); expect(e.pending).toBeFalsy();
    expect(counted(e)).toBe(false); expect(toReview(e)).toBe(true); expect(e.review_item?.kcal.best).toBe(260);
    expect(r.queue.some((o) => o.kind === 'pending')).toBe(false); // no second resolve -> no duplicate
    expect(r.queue.filter((o) => o.kind === 'upsert')).toHaveLength(1); // coalesced on the same id
    // a second late answer can't create another item
    const again = fillPending(r.entries, r.queue, 'p1', [ai('egg bhurji', 300)]);
    expect(again.changed).toBe(false);
  });
  test('late answer never touches an entry that was already resolved/confirmed', () => {
    const s = tapAdd([], [], food('p1', 0));
    const saved = { ...s.entries[0], pending: false, needs_review: false, confirmed: true };
    const r = fillPending([saved], [], 'p1', [ai('egg bhurji', 260)]);
    expect(r.changed).toBe(false); expect(r.entries[0]).toBe(saved);
  });
  test('sync resolves first, then the late answer is ignored (single entry)', async () => {
    const s = tapAdd([], [], food('p1', 0));
    const { rest, resolved } = await flush(s.queue, { upsertEntry: async () => {}, deleteEntry: async () => {}, deleteRemembered: async () => {},
      resolvePending: (f) => resolvePending({ parse: async () => ({ items: [ai('egg bhurji', 260)] } as never) }, f) }, 0);
    expect(rest).toEqual([]);
    const entries = s.entries.map((e) => resolved.find((x) => x.id === e.id) ?? e);
    expect(entries).toHaveLength(1); expect(entries[0].needs_review).toBe(true);
    expect(fillPending(entries, rest, 'p1', [ai('egg bhurji', 999)]).changed).toBe(false);
  });
  test('splitBySpan maps a batched answer back to spans', () => {
    const r = splitBySpan([ai('egg bhurji', 260), ai('cold coffee', 220)], ['egg bhurji', 'cold coffee']);
    expect(r.map((x) => x.map((i) => i.kcal.best))).toEqual([[260], [220]]);
  });
});

describe('Log total/button rules', () => {
  const base = { kcal: 325, protein: 9, items: 2, estimating: 0, pending: 0, toConfirm: 0, estimates: 0, needsKcal: 0 };
  test('estimating: enabled, "Add 325 kcal · 2 estimating", kcal so far', () => {
    const s = logSummary({ ...base, estimating: 2 });
    expect(s.button).toBe('Add 325 kcal · 2 estimating'); expect(s.disabled).toBe(false); expect(s.total).toBe('Total · 2 estimating'); expect(s.soFar).toBe(true);
  });
  test('all estimates', () => {
    const s = logSummary({ ...base, kcal: 780, items: 3, estimates: 3, toConfirm: 3 });
    expect(s.allEstimates).toBe(true); expect(s.button).toBe('Confirm & add 780 kcal'); expect(s.total).toBe('Total · 3 estimates');
  });
  test('mixed list is not all-estimates', () => expect(logSummary({ ...base, items: 3, estimates: 2, toConfirm: 2 }).allEstimates).toBe(false));
  test('offline pending', () => expect(logSummary({ ...base, pending: 1 }).button).toBe('Add 325 kcal · 1 pending'));
  test('to confirm', () => expect(logSummary({ ...base, toConfirm: 2, kcal: 1080 }).button).toBe('Confirm 2 & add 1,080 kcal'));
});

test('202 parse job: pending until done', () => {
  expect(() => parseJobBody({ status: 'pending', job_id: 'j1' })).toThrow(ParsePending);
  expect(parseJobBody({ status: 'done', result: { items: [] } as never }).items).toEqual([]);
});
test('a pending food with a running job keeps its job id and stays queued', async () => {
  const { rest } = await flush([{ kind: 'pending', food: food(), tries: 0 }], { upsertEntry: async () => {}, deleteEntry: async () => {}, deleteRemembered: async () => {},
    resolvePending: (f) => resolvePending({ parse: async () => { throw new ParsePending('j9'); } }, f) }, 0);
  expect(rest).toHaveLength(1); expect((rest[0] as { food: PendingFood }).food.job_id).toBe('j9');
});
import { ApiError } from '../src/lib/api';
import { parseLocal } from '../src/lib/parseLocal';
test('lost AI job (404/410): keep the item queued as needs_review, clear the job, parse again later', async () => {
  const f = { ...food(), job_id: 'gone' };
  let calls = 0;
  const api = { parse: async () => { calls++; return { items: [ai('egg bhurji', 260)] } as never; }, parseJob: async () => { throw new ApiError(404, 'no job'); } };
  const s = { upsertEntry: async () => {}, deleteEntry: async () => {}, deleteRemembered: async () => {}, resolvePending: (x: PendingFood) => resolvePending(api, x) };
  const a = await flush([{ kind: 'pending', food: f, tries: 0 }], s, 0);
  expect(a.rest).toHaveLength(1); expect((a.rest[0] as { food: PendingFood }).food.job_id).toBeUndefined(); expect(calls).toBe(0);
  const b = await flush(a.rest, s, 1e12);
  expect(calls).toBe(1); expect(b.rest).toEqual([]); expect(b.resolved[0].needs_review).toBe(true);
});
test('default_portion: set offline when the amount was not typed; not for stated amounts', () => {
  expect(parseLocal('dal').items[0].default_portion).toBe(true);
  expect(parseLocal('2 katori dal').items[0].default_portion).toBe(false);
});
test('everyday combo: two normal rows, default portions, combo unit multiplies, not flagged', () => {
  const r = parseLocal('dal chawal');
  expect(r.items.map((i) => i.dish_id)).toEqual(['dal', 'rice']);
  expect(r.items.every((i) => i.from_combo === 'dal_chawal' && i.default_portion && !i.needs_confirmation)).toBe(true);
  const two = parseLocal('2 plate dal chawal').items;
  expect(two.map((i) => i.quantity)).toEqual(r.items.map((i) => i.quantity * 2));
  expect(parseLocal('chole bhature').items.find((i) => i.dish_id === 'bhatura')?.quantity).toBe(2);
  expect(r.total.kcal).toBe(r.items.reduce((a, i) => a + i.kcal.best, 0));
});
import * as fs from 'fs';
import * as path from 'path';
import { BRAND, palette } from '../src/theme/tokens';
test('hard rule: the light accent fill is never text or icon colour', () => {
  expect(palette.light.em).toBe(BRAND.light.accentText); expect(palette.light.em).not.toBe(BRAND.light.accentFill);
  expect(palette.light.onGrad).toBe('#241A0C'); // full-b2 on-accent
  const walk = (d: string): string[] => fs.readdirSync(d).flatMap((f) => { const p = path.join(d, f); return fs.statSync(p).isDirectory() ? walk(p) : p.endsWith('.tsx') ? [p] : []; });
  for (const f of walk(path.join(__dirname, '../src'))) {
    const src = fs.readFileSync(f, 'utf8');
    expect([f, /(color|tone|stroke)=\{?[^}\n]*accentFill/.test(src)]).toEqual([f, false]);
  }
});
