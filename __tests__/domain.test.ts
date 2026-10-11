import { suggest } from '../src/lib/coach';
import { computeStreak, computeTargets, entryFromItem, slotFor, weekStart } from '../src/lib/domain';
import { enqueue, flush, Op } from '../src/lib/syncQueue';
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
  const rest = await flush(q, { upsertEntry: async (x) => { sent.push(x); throw new Error('offline'); }, deleteEntry: async () => {} });
  expect(rest[0].tries).toBe(1);
  expect(await flush(rest, { upsertEntry: async () => {}, deleteEntry: async () => {} })).toEqual([]);
});
