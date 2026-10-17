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
  // Oct 17 (team): the cap copy always shows the reset time (IST here); 'later' only when it is unknown
  test('user_limit with number and reset time', () => expect(failedCopy({ reason: 'user_limit', userDailyLimit: 3, resetsAt: at }, new Date('2026-10-15T05:00:00Z'), 'Asia/Kolkata')).toBe('Today’s free estimates are used up. Add the calories yourself, or try again after 12:30 PM.'));
  test('user_limit without reset time / number', () => expect(failedCopy({ reason: 'user_limit' })).toBe('Today’s free estimates are used up. Add the calories yourself, or try again later.'));
  test('daily_limit with time', () => expect(failedCopy({ reason: 'daily_limit', resetsAt: at }, new Date('2026-10-14T10:00:00Z'), 'Asia/Kolkata')).toBe('Today’s free estimates are used up. Add the calories yourself, or try again tomorrow after 12:30 PM.'));
  test('daily_limit without time', () => expect(failedCopy({ reason: 'daily_limit' })).toBe('Today’s free estimates are used up. Add the calories yourself, or try again later.'));
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
  expect(p.button).toBe('Confirm 1 · 1 still needs a choice'); // frame log-estimate-failed
  expect(p.later).toBe(`Add ${roti.kcal.best} kcal · 1 to review later`);
  expect(plan([{ key: 'r', it: roti, confirmed: false }], 0, failedWaiting([{ ...f[0], kcal: '200', added: true }])).button).toBe(`Add ${roti.kcal.best} kcal`);
});

test('secondary "to review later" counts every open item', () => {
  const roti = parser.parse('2 roti').items[0];
  const momos = { ...parser.parse('8 plates momos').items[0], one_tap_ok: false, flags: ['unit_mismatch'], needs_confirmation: true };
  const p = plan([{ key: 'r', it: roti, confirmed: false }, { key: 'm', it: momos, confirmed: false }], 1, 1);
  expect(p.later).toBe(`Add ${roti.kcal.best} kcal · 3 to review later`);
  const none = plan([{ key: 'm', it: momos, confirmed: false }], 1, 1);
  expect(none.later).toBe('Save · 3 to review later');
  expect(none.primary).toBe(false); expect(p.primary).toBe(true);
  expect(plan([{ key: 'r', it: roti, confirmed: false }]).later).toBe('');
});

import { failedRows, failedSpans, pollDelay } from '../src/lib/aiRows';
import { parseJobBody } from '../src/lib/api';
describe('ai_state drives the row (backend a72964e)', () => {
  const base = { items: [], unmatched: ['thukpa'], custom_items: [] };
  test('estimating keeps the row Estimating, even with a busy reason', () => {
    for (const r of ['rate_limited', 'unavailable', 'timeout', undefined])
      expect(aiStatus({ ...base, fallback: 'used', ai_state: 'estimating', fallback_reason: r } as never)).toBe('estimating');
  });
  test('answered with AI items -> ready; answered with none -> failed', () => {
    expect(aiStatus({ ...base, items: [thukpa], fallback: 'used', ai_state: 'answered' } as never)).toBe('ready');
    expect(aiStatus({ ...base, fallback: 'cache', ai_state: 'answered' } as never)).toBe('failed');
  });
  test('failed wins over any fallback value', () => {
    for (const r of ['user_limit', 'daily_limit', 'error'])
      expect(aiStatus({ ...base, fallback: 'used', ai_state: 'failed', fallback_reason: r } as never)).toBe('failed');
  });
  test('pending poll body carries next_attempt_at; still estimating', () => {
    let err: unknown;
    try { parseJobBody({ status: 'pending', job_id: 'j1', ai_state: 'estimating', next_attempt_at: '2026-10-15T10:00:30Z' } as never); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ParsePending);
    expect((err as ParsePending).nextAttemptAt).toBe('2026-10-15T10:00:30Z');
    expect(aiStatus(err)).toBe('estimating');
  });
  test('failed body via the job poll returns the response (not a throw) with no kcal', () => {
    const r = parseJobBody({ status: 'done', ai_state: 'failed', answer: 'none', fallback: 'cap_reached', fallback_reason: 'user_limit', user_daily_limit: 3,
      ai_resets_at: '2026-10-16T00:00:00-07:00', items: [], unmatched: ['thukpa'], failed_spans: [{ span_start: 0, span_end: 6, text: 'thukpa' }],
      custom_items: [{ custom_name: 'thukpa', needs_input: true }] } as never);
    expect(aiStatus(r)).toBe('failed');
    expect(failedRows(r, ['thukpa'])).toEqual(['thukpa']);
    expect(failedCopy({ reason: r.fallback_reason, userDailyLimit: r.user_daily_limit, resetsAt: r.ai_resets_at }, new Date('2026-10-16T03:00:00Z'), 'Asia/Kolkata')).toBe('Today’s free estimates are used up. Add the calories yourself, or try again after 12:30 PM.');
  });
});

describe('failed shape: failed_spans and custom_items needs_input', () => {
  const r = (o: object) => ({ items: [], unmatched: [], fallback: 'error', ai_state: 'failed', custom_items: [], ...o }) as never;
  test('failed_spans first', () => expect(failedSpans(r({ failed_spans: [{ span_start: 0, span_end: 6, text: 'thukpa' }],
    custom_items: [{ custom_name: 'other', needs_input: true }] }), ['x'])).toEqual(['thukpa']));
  test('then custom_items with needs_input only', () => expect(failedSpans(r({ custom_items: [{ custom_name: 'a', needs_input: true }, { custom_name: 'b', needs_input: false }] }), ['x'])).toEqual(['a']));
  test('then the asked spans', () => expect(failedSpans(r({}), ['x', 'y'])).toEqual(['x', 'y']));
  test('rows: every asked span plus extra open spans, no duplicates', () =>
    expect(failedRows(r({ failed_spans: [{ span_start: 0, span_end: 6, text: 'thukpa' }, { span_start: 8, span_end: 14, text: 'zanthu' }] }), ['thukpa'])).toEqual(['thukpa', 'zanthu']));
});

describe('poll interval', () => {
  const now = Date.parse('2026-10-15T10:00:00Z');
  test('no hint -> 2 s', () => expect(pollDelay(undefined, now)).toBe(2000));
  test('bad hint -> 2 s', () => expect(pollDelay('soon', now)).toBe(2000));
  test('past hint -> 2 s floor', () => expect(pollDelay('2026-10-15T09:59:00Z', now)).toBe(2000));
  test('30 s requeue -> wait until then', () => expect(pollDelay('2026-10-15T10:00:20Z', now)).toBe(20000));
  test('5 min requeue -> capped at 30 s', () => expect(pollDelay('2026-10-15T10:05:00Z', now)).toBe(30000));
});

describe('reset time from ai_resets_at (Pacific RFC 3339) in local time', () => {
  test('midnight PT is the same instant as 07:00Z', () => expect(resetTime('2026-10-16T00:00:00-07:00')).toBe(resetTime('2026-10-16T07:00:00Z')));
  test('in IST that is 12:30 PM', () => {
    const d = new Date('2026-10-16T00:00:00-07:00');
    if (-d.getTimezoneOffset() === 330) expect(resetTime('2026-10-16T00:00:00-07:00')).toBe('12:30 PM');
    expect(resetTime('2026-10-16T00:00:00-07:00', 'Asia/Kolkata')).toBe('12:30 PM');
  });
  test('daily_limit copy is the plain cap copy with or without it', () => {
    expect(failedCopy({ reason: 'daily_limit', resetsAt: '2026-10-16T00:00:00-07:00' }, new Date('2026-10-16T03:00:00Z'), 'Asia/Kolkata')).toBe('Today’s free estimates are used up. Add the calories yourself, or try again after 12:30 PM.');
    expect(failedCopy({ reason: 'daily_limit', resetsAt: 'garbage' })).toBe('Today’s free estimates are used up. Add the calories yourself, or try again later.');
  });
});

describe('gave_up (busy > 30 min) is final', () => {
  test('failed, generic copy', () => {
    expect(aiStatus({ items: [], unmatched: ['x'], fallback: 'error', fallback_reason: 'gave_up', ai_state: 'failed', custom_items: [] } as never)).toBe('failed');
    expect(aiStatus({ items: [], unmatched: ['x'], fallback: 'busy', fallback_reason: 'gave_up', custom_items: [] } as never)).toBe('failed');
    expect(failedCopy({ reason: 'gave_up' })).toBe('Couldn’t estimate this. Add the calories yourself.');
  });
  test.each(['rate_limited', 'unavailable', 'timeout'])('%s is never failed without ai_state', (r) =>
    expect(aiStatus({ items: [], unmatched: ['x'], fallback: 'error', fallback_reason: r, custom_items: [] } as never)).toBe('estimating'));
});

test('estimate-failed frame: "Confirm 2 · 1 still needs a choice" + outline "Add {kcal} kcal · 1 to review later"', () => {
  const roti = parser.parse('2 roti').items[0], dal = parser.parse('dal').items[0];
  const p = plan([{ key: 'r', it: roti, confirmed: true }, { key: 'd', it: dal, confirmed: true }], 0, 1);
  expect(p.button).toBe('Confirm 2 · 1 still needs a choice');
  expect(p.later).toBe(`Add ${roti.kcal.best + dal.kcal.best} kcal · 1 to review later`);
});
test('app-side user_limit uses the plain cap copy', () =>
  expect(failedCopy({ reason: 'user_limit', userDailyLimit: 3 })).toBe('Today’s free estimates are used up. Add the calories yourself, or try again later.'));
test('3f4f401: fallback "gave_up" alone (no ai_state) is failed with generic copy', () => {
  expect(aiStatus({ items: [], unmatched: ['x'], fallback: 'gave_up', custom_items: [] } as never)).toBe('failed');
  expect(aiStatus({ items: [], unmatched: ['x'], fallback: 'gave_up', fallback_reason: 'gave_up', ai_state: 'failed', custom_items: [] } as never)).toBe('failed');
});

describe('bad_request is final like gave_up', () => {
  test('failed (with and without ai_state), generic copy', () => {
    expect(aiStatus({ items: [], unmatched: ['x'], fallback: 'error', fallback_reason: 'bad_request', ai_state: 'failed', custom_items: [] } as never)).toBe('failed');
    expect(aiStatus({ items: [], unmatched: ['x'], fallback: 'error', fallback_reason: 'bad_request', custom_items: [] } as never)).toBe('failed');
    expect(aiStatus({ items: [], unmatched: ['x'], fallback: 'bad_request', custom_items: [] } as never)).toBe('failed');
    expect(failedCopy({ reason: 'bad_request' })).toBe('Couldn’t estimate this. Add the calories yourself.');
  });
  test.each(['daily_limit', 'user_limit', 'error', 'gave_up', 'bad_request'])('%s fallback_reason is failed', (r) =>
    expect(aiStatus({ items: [], unmatched: ['x'], fallback: 'busy', fallback_reason: r, custom_items: [] } as never)).toBe('failed'));
  test.each(['rate_limited', 'unavailable', 'timeout'])('%s stays estimating', (r) =>
    expect(aiStatus({ items: [], unmatched: ['x'], fallback: 'busy', fallback_reason: r, custom_items: [] } as never)).toBe('estimating'));
});
