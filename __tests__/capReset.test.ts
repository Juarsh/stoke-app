// Cap copy with the server's next_reset_at (team, Oct 17): local h:mm AM/PM; "tomorrow after" when the reset falls on a
// later local date; "later" only when unknown. The app's own 3-a-day count resets at that same instant.
import { capCopy, failedCopy, resetWhen } from '../src/lib/aiRows';
import { countAi, localCapHit, noteReset, rollQuota } from '../src/lib/aiQuota';

const HEAD = 'Today’s free estimates are used up. Add the calories yourself, or try again';
const at = (iso: string) => new Date(iso);
// what the server sends (Quota.NextReset = midnight America/Los_Angeles)
const OCT18 = '2026-10-18T00:00:00-07:00'; // 12:30 PM IST Oct 18 (PDT)
const OCT19 = '2026-10-19T00:00:00-07:00';
const NOV2 = '2026-11-02T00:00:00-08:00';  // 1:30 PM IST Nov 2 (PST from Nov 1)
const IST = 'Asia/Kolkata';

describe('IST device', () => {
  test('just before 12:30 PM IST: today, after 12:30 PM', () =>
    expect(capCopy(OCT18, at('2026-10-18T06:59:00Z'), IST)).toBe(`${HEAD} after 12:30 PM.`)); // 12:29 PM IST
  test('just after 12:30 PM IST: the server already sends the next day -> tomorrow after 12:30 PM', () =>
    expect(capCopy(OCT19, at('2026-10-18T07:01:00Z'), IST)).toBe(`${HEAD} tomorrow after 12:30 PM.`)); // 12:31 PM IST
  test('in the morning before the reset: today', () => expect(capCopy(OCT18, at('2026-10-17T19:00:00Z'), IST)).toBe(`${HEAD} after 12:30 PM.`)); // 00:30 IST Oct 18
  test('late evening: tomorrow', () => expect(capCopy(OCT18, at('2026-10-17T17:00:00Z'), IST)).toBe(`${HEAD} tomorrow after 12:30 PM.`)); // 10:30 PM IST Oct 17
  test('across Nov 1 (US DST ends): 1:30 PM IST', () => {
    expect(capCopy(NOV2, at('2026-11-01T07:01:00Z'), IST)).toBe(`${HEAD} tomorrow after 1:30 PM.`); // Nov 1, 12:31 PM IST
    expect(capCopy(NOV2, at('2026-11-02T05:00:00Z'), IST)).toBe(`${HEAD} after 1:30 PM.`);          // Nov 2, 10:30 AM IST
    expect(capCopy(NOV2, at('2026-11-02T07:59:00Z'), IST)).toBe(`${HEAD} after 1:30 PM.`);          // Nov 2, 1:29 PM IST
  });
});

describe('non-IST device time zones', () => {
  test('New York: the same instant is 3:00 AM, tomorrow from the evening before', () => {
    expect(capCopy(OCT18, at('2026-10-17T23:00:00Z'), 'America/New_York')).toBe(`${HEAD} tomorrow after 3:00 AM.`); // 7 PM EDT Oct 17
    expect(capCopy(OCT18, at('2026-10-18T05:00:00Z'), 'America/New_York')).toBe(`${HEAD} after 3:00 AM.`);          // 1 AM EDT Oct 18
  });
  test('London 8:00 AM BST; Los Angeles midnight is 12:00 AM', () => {
    expect(capCopy(OCT18, at('2026-10-18T06:00:00Z'), 'Europe/London')).toBe(`${HEAD} after 8:00 AM.`);
    expect(capCopy(OCT18, at('2026-10-17T20:00:00Z'), 'America/Los_Angeles')).toBe(`${HEAD} tomorrow after 12:00 AM.`);
  });
  test('Nov 2 PST in Dubai: 12:00 PM', () => expect(resetWhen(NOV2, at('2026-11-02T04:00:00Z'), 'Asia/Dubai')).toEqual({ time: '12:00 PM', laterDay: false }));
  test('the device zone is used when none is given', () => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(capCopy(OCT18, at('2026-10-17T23:00:00Z'))).toBe(capCopy(OCT18, at('2026-10-17T23:00:00Z'), tz));
  });
});

describe('unknown reset', () => {
  test.each([undefined, '', 'garbage'])('%p -> later', (r) => expect(capCopy(r as string | undefined)).toBe(`${HEAD} later.`));
  test('never "tomorrow" without a time; always a time or "later"', () => {
    for (const r of [OCT18, OCT19, NOV2, undefined]) for (const reason of ['user_limit', 'daily_limit', 'cap_reached', 'global_cap_reached']) {
      const c = failedCopy({ reason, resetsAt: r }, at('2026-10-18T03:00:00Z'), IST);
      expect(c).toMatch(/(after \d{1,2}:\d{2} (AM|PM)|later)\.$/);
      expect(c).not.toMatch(/tomorrow\.$/);
    }
  });
});

describe('the app’s own 3-a-day count resets at next_reset_at, not local midnight', () => {
  const t = (iso: string) => Date.parse(iso);
  test('blocks before the reset, not after (local midnight changes nothing)', () => {
    let q = noteReset(undefined, OCT18, t('2026-10-17T10:00:00Z'));
    for (let i = 0; i < 3; i++) q = countAi(q, t('2026-10-17T10:00:00Z'));
    expect(localCapHit(q, 3, t('2026-10-17T18:31:00Z'))).toBe(true);  // 00:01 IST Oct 18: a new local day, still blocked
    expect(localCapHit(q, 3, t('2026-10-18T06:59:00Z'))).toBe(true);  // 12:29 PM IST
    expect(localCapHit(q, 3, t('2026-10-18T07:00:00Z'))).toBe(false); // 12:30 PM IST: the server's reset
    expect(rollQuota(q, t('2026-10-18T07:00:00Z'))).toEqual({ used: 0 });
  });
  test('across Nov 1: blocked until 1:30 PM IST', () => {
    let q = noteReset(undefined, NOV2, t('2026-11-01T08:00:00Z'));
    for (let i = 0; i < 3; i++) q = countAi(q, t('2026-11-01T08:00:00Z'));
    expect(localCapHit(q, 3, t('2026-11-02T07:30:00Z'))).toBe(true);  // 1:00 PM IST
    expect(localCapHit(q, 3, t('2026-11-02T08:00:00Z'))).toBe(false); // 1:30 PM IST
  });
  test('a later next_reset_at from the server means its day rolled (phone clock behind): count restarts', () => {
    let q = noteReset(undefined, OCT18, t('2026-10-18T06:00:00Z'));
    for (let i = 0; i < 3; i++) q = countAi(q, t('2026-10-18T06:00:00Z'));
    q = noteReset(q, OCT19, t('2026-10-18T06:58:00Z'));
    expect(q).toEqual({ used: 0, resetAt: OCT19 });
    expect(noteReset(q, OCT19)).toBe(q);
  });
  test('reset unknown: the app never blocks on its own', () => {
    expect(localCapHit({ used: 9 }, 3)).toBe(false);
  });
});

import { createApi } from '../src/lib/api';
test('every server response with next_reset_at reaches the store (onReset)', async () => {
  const seen: string[] = [];
  const f = jest.fn(async () => ({ ok: true, status: 202, json: async () => ({ status: 'pending', job_id: 'j1', ai_state: 'estimating', next_reset_at: OCT18 }), text: async () => '' }));
  (global as unknown as { fetch: unknown }).fetch = f;
  const api = createApi(() => 'tok', (iso) => seen.push(iso));
  await expect(api.parseJob('j1')).rejects.toBeTruthy(); // still pending
  expect(seen).toEqual([OCT18]);
});
