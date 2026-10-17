// 35-minute phone-side AI backstop (Product, Oct 17): a meal still Estimating / pending AI after 35 min becomes a failed AI row.
import { AI_BACKSTOP_MS, backstopDue, BACKSTOP_REASON, dropLate, dropLateOps, expirePending, failedAiItem, pendingStart, stampPending } from '../src/lib/aiBackstop';
import { failedCopy } from '../src/lib/aiRows';
import { bulkEligible, canConfirm, reviewBulk, reviewRowKind, reviewSummary } from '../src/lib/confirmBatch';
import { counted, dayTotals, FoodEntry, hasKcal, pendingEntry, toReview } from '../src/lib/domain';
import { fillPending } from '../src/lib/pending';
import { enqueue, Op, PendingFood } from '../src/lib/syncQueue';
import { parser } from '../src/parser';

const MIN = 60_000;
const T0 = Date.parse('2026-10-17T04:00:00Z');
const food = (id = 'p1', queued_at: number | undefined = T0): PendingFood => ({ id, span: 'dum aloo lakhnavi', slot: 'lunch', local_date: '2026-10-17', raw_text: 'dum aloo lakhnavi 1 katori', at: 0, queued_at });
function queued(f: PendingFood, created = new Date(T0)) {
  const ph = pendingEntry(f, created);
  const q = enqueue(enqueue([], { kind: 'upsert', entry: ph, tries: 0 }), { kind: 'pending', food: f, tries: 0 });
  return { entries: [ph], queue: q };
}
const ai = (kcal: number) => ({ ...parser.parse('dal').items[0], dish_id: '', name: 'dum aloo lakhnavi', matched_text: 'dum aloo lakhnavi', source: 'ai_estimate' as const,
  ai_estimate: true, needs_confirmation: true, kcal: { low: kcal - 40, best: kcal, high: kcal + 40 } });

describe('35-minute cutoff boundary', () => {
  test('34 min: still estimating; 36 min: failed', () => {
    expect(AI_BACKSTOP_MS).toBe(35 * MIN);
    expect(backstopDue(T0, T0 + 34 * MIN)).toBe(false);
    expect(backstopDue(T0, T0 + 35 * MIN)).toBe(false); // "more than 35 minutes"
    expect(backstopDue(T0, T0 + 36 * MIN)).toBe(true);
    expect(backstopDue(new Date(T0).toISOString(), T0 + 36 * MIN)).toBe(true); // stored ISO timestamps work too
  });
  test('no stored start never expires', () => {
    expect(backstopDue(undefined, T0 + 999 * MIN)).toBe(false);
    expect(backstopDue('garbage', T0 + 999 * MIN)).toBe(false);
  });
  test('queued food at 34 min is untouched; at 36 min it becomes a failed AI review row', () => {
    const s = queued(food());
    const at34 = expirePending(s.entries, s.queue, T0 + 34 * MIN);
    expect(at34.converted).toEqual([]); expect(at34.entries).toBe(s.entries); expect(at34.queue).toBe(s.queue);
    const at36 = expirePending(s.entries, s.queue, T0 + 36 * MIN);
    expect(at36.converted).toEqual(['p1']);
    const e = at36.entries.find((x) => x.id === 'p1')!;
    expect(at36.entries).toHaveLength(1);
    expect(e.pending).toBe(false); expect(e.needs_review).toBe(true); expect(e.ai_expired).toBe(true); expect(e.ai_fail_reason).toBe(BACKSTOP_REASON);
    expect(toReview(e)).toBe(true); expect(counted(e)).toBe(false);
    expect(failedCopy({ reason: e.ai_fail_reason })).toBe('Couldn’t estimate this. Add the calories yourself.');
    // the job poll stops: no pending op left; the row is synced once as needs_review (no number)
    expect(at36.queue.some((o) => o.kind === 'pending')).toBe(false);
    const ups = at36.queue.filter((o): o is Extract<Op, { kind: 'upsert' }> => o.kind === 'upsert');
    expect(ups).toHaveLength(1); expect(ups[0].entry.ai_expired).toBe(true); expect(ups[0].entry.kcal.best).toBe(0);
  });
  test('start falls back to the placeholder created_at; older queues get a stamp', () => {
    const { queued_at: _q, ...f } = food('p2'); // an older stored queue: no queued_at
    const s = queued(f, new Date(T0));
    expect(pendingStart(f, s.entries)).toBe(T0);
    expect(expirePending(s.entries, s.queue, T0 + 36 * MIN).converted).toEqual(['p2']);
    const stamped = stampPending([{ kind: 'pending', food: f, tries: 0 }], [], T0 + 5 * MIN);
    expect((stamped[0] as Extract<Op, { kind: 'pending' }>).food.queued_at).toBe(T0 + 5 * MIN);
    expect(expirePending([], stamped, T0 + 39 * MIN).converted).toEqual([]); // 34 min after the stamp
  });
});

describe('converted row: typed kcal only, never bulk, never 0', () => {
  const s = queued(food());
  const e = expirePending(s.entries, s.queue, T0 + 36 * MIN).entries[0];
  const it = e.review_item!;
  test('needs typed kcal (kcal row), not bulk-eligible', () => {
    expect(reviewRowKind(it)).toBe('kcal');
    expect(bulkEligible({ ...it, one_tap_ok: true })).toBe(false);
    expect(bulkEligible({ ...it, one_tap_ok: true }, true)).toBe(false);
    expect(reviewBulk([e])).toEqual([]);
    expect(reviewSummary([e]).button).toBeNull();
    expect(reviewSummary([e]).stillText).toBe('1 still needs you');
  });
  test('store guard (hasKcal && canConfirm) refuses it without real kcal', () => {
    expect(hasKcal(it)).toBe(false); expect(canConfirm(it)).toBe(false);
    expect(canConfirm(failedAiItem('x'))).toBe(false);
  });
  test('never counted as 0', () => {
    expect(dayTotals([e])).toEqual({ kcal: 0, protein: 0 });
    expect(counted(e)).toBe(false);
  });
});

describe('late server result for a converted job is ignored', () => {
  const s = queued(food());
  const x = expirePending(s.entries, s.queue, T0 + 36 * MIN);
  const filled: FoodEntry = { ...x.entries[0], source: 'custom', kcal: { low: 300, best: 300, high: 300 }, confirmed: true, needs_review: false, review_item: undefined };
  test('fillPending (Log late answer) does nothing', () => {
    expect(fillPending(x.entries, x.queue, 'p1', [ai(260)]).changed).toBe(false);
    expect(fillPending([filled], [], 'p1', [ai(260)]).changed).toBe(false);
  });
  test('a sync that raced the conversion: resolved entries and their ops are dropped, the user\'s row stays', () => {
    const late: FoodEntry[] = [{ ...filled, id: 'p1', kcal: { low: 220, best: 260, high: 300 }, ai_expired: undefined, needs_review: true }, { ...filled, id: 'p1-1', ai_expired: undefined }];
    expect(dropLate([filled], late)).toEqual([]);
    const rest: Op[] = [{ kind: 'pending', food: food(), tries: 1 }, ...late.map((entry): Op => ({ kind: 'upsert', entry, tries: 0 })), { kind: 'upsert', entry: filled, tries: 0 }];
    expect(dropLateOps(rest, [filled])).toEqual([{ kind: 'upsert', entry: filled, tries: 0 }]);
  });
  test('other foods are not affected', () => {
    const other: FoodEntry = { ...filled, id: 'q9', ai_expired: undefined };
    expect(dropLate([filled], [other])).toEqual([other]);
  });
});
