import { suggest } from '../src/lib/coach';
import { computeStreak, computeTargets, entryFromItem, slotFor, weekStart } from '../src/lib/domain';
import { backoffMs, enqueue, flush, Op } from '../src/lib/syncQueue';
import { ApiError } from '../src/lib/api';
import { DISH_TABLE_VERSION, DISHES, parser } from '../src/parser';

test('targets', () => {
  const t = computeTargets({ goal: 'maintain', sex: 'm', age: 30, heightCm: 172, weightKg: 68, activity: 'light' });
  expect(t.protein).toBe(82);
  expect(t.kcal).toBeGreaterThan(2200);
});
test('slots in IST', () => {
  expect(slotFor(new Date('2026-10-12T04:00:00Z'))).toBe('breakfast'); // 09:30 IST
  expect(slotFor(new Date('2026-10-12T07:00:00Z'))).toBe('lunch');
  expect(slotFor(new Date('2026-10-12T11:00:00Z'))).toBe('snacks');
  expect(slotFor(new Date('2026-10-12T14:00:00Z'))).toBe('dinner');
});
test('streak: auto freeze once per week', () => {
  expect(weekStart('2026-10-14')).toBe('2026-10-12');
  const s = computeStreak(['2026-10-12', '2026-10-13', '2026-10-15', '2026-10-16'], '2026-10-16');
  expect(s.current).toBe(4); expect(s.frozenDays).toEqual(['2026-10-14']);
  const broken = computeStreak(['2026-10-12', '2026-10-14', '2026-10-16'], '2026-10-16');
  expect(broken.current).toBe(1);
  expect(computeStreak(['2026-10-15'], '2026-10-16').current).toBe(1); // today not logged yet
});
test('saved entries are snapshots carrying the table version', () => {
  const [it] = parser.parse('2 roti').items;
  const e = entryFromItem(it, { slot: 'lunch', raw_text: '2 roti', local_date: '2026-10-12', tableVersion: DISH_TABLE_VERSION, id: 'x' });
  it.kcal.best = 9999;
  expect(e.kcal.best).toBe(220);
  expect(e.dish_table_version).toBe(DISH_TABLE_VERSION);
});
test('coach: veg never gets non-veg, never over target', () => {
  for (const [k, p] of [[520, 38], [200, 10], [900, 60]]) {
    const s = suggest(DISHES, k, p, 'veg');
    expect(s.length).toBeGreaterThan(0);
    for (const x of s) { expect(x.dish.diet).toBe('veg'); expect(x.kcal).toBeLessThanOrEqual(k); }
  }
  expect(suggest(DISHES, 50, 10, 'nonveg')).toEqual([]);
});
test('sync queue coalesces and stops on failure without changing payload', async () => {
  const e = entryFromItem(parser.parse('dal').items[0], { slot: 'lunch', raw_text: 'dal', local_date: '2026-10-12', tableVersion: 1, id: 'a' });
  let q: Op[] = enqueue([], { kind: 'upsert', entry: e, tries: 0 });
  q = enqueue(q, { kind: 'upsert', entry: { ...e, qty: 2 }, tries: 0 });
  expect(q).toHaveLength(1);
  const sent: unknown[] = [];
  const base = { upsertEntry: async () => {}, deleteEntry: async () => {}, resolvePending: async () => null, deleteRemembered: async () => {} };
  const { rest } = await flush(q, { ...base, upsertEntry: async (x) => { sent.push(x); throw new ApiError(503, 'busy'); } }, 1000);
  expect(rest).toHaveLength(1); // never dropped on a server / network error (a 409 is surfaced on the entry instead: syncVersion.test)
  expect(rest[0].tries).toBe(1);
  expect(rest[0].nextAt).toBe(1000 + backoffMs(1));
  expect((await flush(rest, base, 1001)).rest).toHaveLength(1); // still backing off
  expect((await flush(rest, base, 1000 + backoffMs(1))).rest).toEqual([]);
  expect(backoffMs(20)).toBe(30 * 60_000);
});
test('pending food stays queued with no number until resolved, then becomes an upsert', async () => {
  const food = { id: 'p1', span: 'quinoa bowl', slot: 'lunch' as const, local_date: '2026-10-12', raw_text: 'quinoa bowl' };
  const q: Op[] = [{ kind: 'pending', food, tries: 0 }];
  const base = { upsertEntry: async () => {}, deleteEntry: async () => {}, deleteRemembered: async () => {} };
  const a = await flush(q, { ...base, resolvePending: async () => null }, 0);
  expect(a.rest[0].kind).toBe('pending'); expect(a.resolved).toEqual([]);
  const e = entryFromItem(parser.parse('dal').items[0], { slot: 'lunch', raw_text: 'quinoa bowl', local_date: '2026-10-12', tableVersion: 1, id: 'p1-0' });
  const sent: string[] = [];
  const b = await flush(a.rest, { ...base, upsertEntry: async (x) => { sent.push(x.id); }, resolvePending: async () => [e] }, 1e12);
  expect(b.resolved.map((x) => x.id)).toEqual(['p1-0']); expect(sent).toEqual(['p1-0']); expect(b.rest).toEqual([]);
});
import { parseLocal } from '../src/lib/parseLocal';
test('did-you-mean comes from the parser (backend rule: >1000 kcal or >3x portion)', () => {
  const r = parseLocal('20 roti');
  expect(r.items[0].needs_confirmation).toBe(true);
  expect(r.items[0].alternatives!.some((a) => a.quantity === 1)).toBe(true);
  expect(parseLocal('2 roti').items[0].needs_confirmation).toBe(false);
});
import { devaFamily, hasDevanagari, palette } from '../src/theme/tokens';
import { itemKind, needsConfirmation } from '../src/lib/itemKind';
test('Devanagari text switches to the matching Noto Sans Devanagari weight', () => {
  expect(hasDevanagari(['2 ', 'रोटी'])).toBe(true);
  expect(hasDevanagari('2 roti')).toBe(false);
  expect(devaFamily('SpaceGrotesk_700Bold')).toBe('NotoSansDevanagari_700Bold');
  expect(devaFamily('Inter_400Regular')).toBe('NotoSansDevanagari_400Regular');
});
test('item kinds come from the parser source field', () => {
  expect(itemKind(parseLocal('20 roti').items[0])).toBe('did_you_mean'); // sanity lowers confidence below threshold
  expect(needsConfirmation(parseLocal('20 roti').items[0])).toBe(true);
  expect(itemKind(parseLocal('2 chapatii').items[0])).toBe('did_you_mean');
  const g = parseLocal('paneer lababdar').items[0];
  expect(itemKind(g)).toBe('generic'); expect(needsConfirmation(g)).toBe(true);
  expect(needsConfirmation(parseLocal('2 roti').items[0])).toBe(false);
  const u = parseLocal('quinoa xyzzy');
  expect(u.items.some((i) => i.kcal.best === 0)).toBe(false);
  expect(u.custom_items.length).toBe(1);
});
test('light over-grey is the full-b2 warm grey', () => { expect(palette.light.over).toBe('#6E655C'); });
import { applyLearned, learnKey, readingOf, reasonWord } from '../src/lib/learned';
test('remembered readings skip confirmation next time', () => {
  const [it] = parseLocal('2 chapatii').items;
  expect(it.needs_confirmation).toBe(true);
  expect(reasonWord(it)).toBe('fuzzy');
  const learned = { [learnKey(it.matched_text)]: readingOf({ ...it, quantity: 3 }) };
  const [r] = applyLearned([it], learned);
  expect(r.needs_confirmation).toBe(false); expect(r.remembered).toBe(true); expect(r.quantity).toBe(3);
  expect(reasonWord(parseLocal('20 roti').items[0])).toBe('portion');
});
import { resolvePending } from '../src/lib/pending';
import type { FoodEntry } from '../src/lib/domain';
import { counted, dayTotals, loggedDays, reviewEntry } from '../src/lib/domain';
import { pendingFor } from '../src/lib/syncQueue';
describe('pending foods never save an unwarned number', () => {
  const food = { id: 'p', span: 'x', slot: 'lunch' as const, local_date: '2026-10-12', raw_text: 'x' };
  const resp = (items: ReturnType<typeof parser.parse>['items']) => ({ parse: async () => ({ items } as never) });
  test('confident table match auto-saves', async () => {
    const [e] = (await resolvePending(resp(parser.parse('dal').items), food)) as FoodEntry[];
    expect(e.needs_review).toBeFalsy(); expect(e.confirmed).toBe(true); expect(counted(e)).toBe(true);
  });
  test.each([
    ['ai estimate', { ...parser.parse('dal').items[0], source: 'ai_estimate', ai_estimate: true, needs_confirmation: true }],
    ['did you mean', parser.parse('2 chapatii').items[0]],
    ['generic', parser.parse('paneer lababdar').items[0]],
  ])('%s becomes a review entry: not counted, not synced', async (_n, it) => {
    expect((it as { needs_confirmation: boolean }).needs_confirmation).toBe(true);
    const [e] = (await resolvePending(resp([it as never]), food)) as FoodEntry[];
    expect(e.needs_review).toBe(true); expect(e.confirmed).toBe(false); expect(counted(e)).toBe(false);
    expect(e.kcal.best).toBe(0); expect(e.review_item).toBeDefined();
    // synced as needs_review (server streak), still not counted
    const sent: FoodEntry[] = [];
    const { rest, resolved } = await flush([{ kind: 'pending', food, tries: 0 }],
      { upsertEntry: async (x) => { sent.push(x); }, deleteEntry: async () => {}, deleteRemembered: async () => {}, resolvePending: async () => [e] }, 0);
    expect(rest).toEqual([]); expect(resolved).toEqual([e]); expect(sent.map((x) => x.needs_review)).toEqual([true]);
  });
  test('review entries and pending are left out of totals', () => {
    const ok = entryFromItem(parser.parse('dal').items[0], { slot: 'lunch', raw_text: 'dal', local_date: '2026-10-12', tableVersion: 1, id: 'a' });
    const rv = reviewEntry(parser.parse('2 chapatii').items[0], { slot: 'lunch', raw_text: 'x', local_date: '2026-10-12', tableVersion: 1, id: 'b' });
    expect(dayTotals([ok, rv]).kcal).toBe(ok.kcal.best);
    expect(pendingFor([{ kind: 'pending', food, tries: 0 }, { kind: 'upsert', entry: ok, tries: 0 }], '2026-10-12')).toEqual([food]);
    expect(pendingFor([{ kind: 'pending', food, tries: 0 }], '2026-10-13')).toEqual([]);
  });
});
test('streak: a day with only pending or needs-review items still counts; calories do not', () => {
  const rv = reviewEntry(parser.parse('2 chapatii').items[0], { slot: 'lunch', raw_text: 'x', local_date: '2026-10-11', tableVersion: 1, id: 'r' });
  const days = loggedDays([rv], ['2026-10-12']);
  expect([...days].sort()).toEqual(['2026-10-11', '2026-10-12']);
  expect(computeStreak(days, '2026-10-12').current).toBe(2);
  expect(dayTotals([rv]).kcal).toBe(0);
  const gone = { ...rv, deleted_at: '2026-10-11T10:00:00Z' };
  expect(loggedDays([gone]).size).toBe(0);
});
import { BRAND } from '../src/theme/tokens';
test('brand roles are separate tokens; over-target is neutral, never accent or delete', () => {
  for (const m of ['light', 'dark'] as const) {
    const b = BRAND[m];
    for (const k of ['accentText', 'accentFill', 'delete', 'warn', 'over', 'streak'] as const) expect(typeof b[k]).toBe('string');
    expect(b.over).not.toBe(b.accentFill); expect(b.over).not.toBe(b.delete);
  }
});
