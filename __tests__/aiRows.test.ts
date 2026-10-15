import { aiStatus, failedCounts, lateAnswer, leaveLog } from '../src/lib/aiRows';
import { ParsePending } from '../src/lib/api';
import { plan, ServerItem } from '../src/lib/confirmBatch';
import { addDays, counted, dayTotals, loggedDays, toReview } from '../src/lib/domain';
import { parser } from '../src/parser';

const resp = (o: object) => ({ items: [], unmatched: [], fallback: 'used', ...o }) as never;
const thukpa = { ...parser.unknown('thukpa'), name: 'thukpa', ai_estimate: true, source: 'ai_estimate', needs_confirmation: true,
  kcal: { low: 220, best: 290, high: 380 }, protein_g: { low: 8, best: 10, high: 12 } } as ServerItem;

describe('status mapping', () => {
  test('pending job -> estimating', () => expect(aiStatus(new ParsePending('j1'))).toBe('estimating'));
  test.each(['error', 'busy', 'cap_reached'])('fallback %s -> failed', (f) => expect(aiStatus(resp({ fallback: f }))).toBe('failed'));
  test('network error -> failed; answer with AI items -> ready', () => {
    expect(aiStatus(new Error('x'))).toBe('failed');
    expect(aiStatus(resp({ items: [thukpa] }))).toBe('ready');
  });
});

describe('estimating + failed rows', () => {
  const roti = parser.parse('2 roti').items[0], dal = parser.parse('dal').items[0];
  test('estimating row: not counted, batch label "Confirm 2 · 1 estimating"', () => {
    const p = plan([{ key: 'r', it: roti, confirmed: false }, { key: 'd', it: dal, confirmed: false }], 1);
    expect(p.button).toBe('Confirm 2 · 1 estimating');
    expect(p.kcal).toBe(roti.kcal.best + dal.kcal.best);
  });
  test('failed row counts only once its kcal is added', () => {
    const f = { key: 'k', id: 'i', name: 'thukpa', kcal: '', protein: '', added: false };
    expect(failedCounts(f)).toBe(false);
    expect(failedCounts({ ...f, kcal: '300' })).toBe(false);
    expect(failedCounts({ ...f, kcal: '300', added: true })).toBe(true);
  });
  test('late answer: same row, never auto-confirmed; dropped if the user typed kcal', () => {
    const late = lateAnswer(undefined, [{ ...thukpa, needs_confirmation: false }]);
    expect(late).toEqual({ drop: false, items: [expect.objectContaining({ needs_confirmation: true })] });
    expect(lateAnswer({ key: 'k', id: 'i', name: 'thukpa', kcal: '310', protein: '', added: false }, [thukpa])).toEqual({ drop: true });
    expect(lateAnswer({ key: 'k', id: 'i', name: 'thukpa', kcal: '', protein: '', added: false }, [thukpa]).drop).toBe(false);
  });
});

test('closing Log with an open unit_mismatch and an AI estimate: both come back on Today as needs_review', () => {
  const momos = parser.parse('8 plates momos').items[0];
  expect(momos.unit_options?.length).toBeGreaterThan(0);
  let n = 0;
  const date = '2026-10-15';
  const { reviews, pending } = leaveLog({ open: [momos, thukpa], failed: [], estimating: [], slot: 'dinner', text: '8 plates momos, thukpa', date, newId: () => `id${n++}` });
  expect(pending).toEqual([]);
  expect(reviews).toHaveLength(2);
  for (const e of reviews) {
    expect(toReview(e)).toBe(true);   // Today: "— kcal · needs review"
    expect(counted(e)).toBe(false);   // never in calories
    expect(e.kcal.best).toBe(0);
  }
  expect(dayTotals(reviews).kcal).toBe(0);
  expect(loggedDays(reviews).has(date)).toBe(true); // counts toward the streak
  // never auto-count, however old
  const old = reviews.map((e) => ({ ...e, local_date: addDays(date, -30) }));
  expect(old.every((e) => !counted(e) && toReview(e))).toBe(true);
});

test('closing Log also keeps estimating spans (pending) and unfilled failed rows (review)', () => {
  const { reviews, pending } = leaveLog({ open: [], failed: [{ key: 'k', id: 'f1', name: 'zanthu', kcal: '', protein: '', added: false }],
    estimating: [{ id: 'e1', span: 'thukpa' }], slot: 'lunch', text: 't', date: '2026-10-15', newId: () => 'x' });
  expect(pending).toEqual([expect.objectContaining({ id: 'e1', span: 'thukpa', at: 0 })]);
  expect(reviews.map((e) => [e.id, toReview(e)])).toEqual([['f1', true]]);
});

import { failedCopy, failedWaiting } from '../src/lib/aiRows';
import { resetTime } from '../src/lib/aiRows';
describe('failed-row copy by fallback_reason', () => {
  const at = '2026-10-15T07:00:00Z'; const time = resetTime(at);
  test('reset time is local h:mm AM/PM', () => expect(time).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/));
  test('user_limit with number and reset time', () => expect(failedCopy({ reason: 'user_limit', userDailyLimit: 3, resetsAt: at }))
    .toBe(`You’ve used today’s 3 AI estimates. Add the calories yourself, or try again after ${time}.`));
  test('user_limit without reset time / number', () => expect(failedCopy({ reason: 'user_limit' }))
    .toBe('You’ve used today’s AI estimates. Add the calories yourself.'));
  test('daily_limit with time', () => expect(failedCopy({ reason: 'daily_limit', resetsAt: at })).toBe(`AI estimates are used up until ${time}. Add the calories yourself.`));
  test('daily_limit without time', () => expect(failedCopy({ reason: 'daily_limit' })).toBe('AI estimates are used up for now. Add the calories yourself.'));
  test.each([undefined, 'error'])('%s -> generic', (r) => expect(failedCopy({ reason: r })).toBe('Couldn’t estimate this. Add the calories yourself.'));
  test.each(['rate_limited', 'unavailable', 'timeout'])('%s keeps the row Estimating', (r) =>
    expect(aiStatus({ items: [], unmatched: ['x'], fallback: 'busy', fallback_reason: r, custom_items: [] } as never)).toBe('estimating'));
  test.each(['user_limit', 'daily_limit', 'error'])('%s fails the row', (r) =>
    expect(aiStatus({ items: [], unmatched: ['x'], fallback: r === 'user_limit' ? 'cap_reached' : r, fallback_reason: r, custom_items: [] } as never)).toBe('failed'));
});
test('a failed row with no kcal shows in the batch label and never hides', () => {
  const roti = parser.parse('2 roti').items[0];
  const f = [{ key: 'z', id: 'z', name: 'zanthu', kcal: '', protein: '', added: false }];
  expect(failedWaiting(f)).toBe(1);
  const p = plan([{ key: 'r', it: roti, confirmed: false }], 0, failedWaiting(f));
  expect(p.button).toBe(`Add ${roti.kcal.best} kcal · 1 still needs a choice`);
  expect(plan([{ key: 'r', it: roti, confirmed: false }], 0, failedWaiting([{ ...f[0], kcal: '200', added: true }])).button).toBe(`Add ${roti.kcal.best} kcal`);
});

test('secondary "to review later" counts every open item', () => {
  const roti = parser.parse('2 roti').items[0];
  const momos = { ...parser.parse('8 plates momos').items[0], one_tap_ok: false, flags: ['unit_mismatch'], needs_confirmation: true };
  const p = plan([{ key: 'r', it: roti, confirmed: false }, { key: 'm', it: momos, confirmed: false }], 1, 1);
  expect(p.later).toBe(`Add ${roti.kcal.best} kcal · 3 to review later`);
  const none = plan([{ key: 'm', it: momos, confirmed: false }], 1, 1);
  expect(none.later).toBe('Save · 3 to review later');
  expect(plan([{ key: 'r', it: roti, confirmed: false }]).later).toBe('');
});
