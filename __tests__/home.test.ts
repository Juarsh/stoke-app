// Home (item 3): Food card totals and remaining, the Last 7 days strip, empty states and the static Coach tip.
import { coachTip, foodCard, lastLine, weekStrip } from '../src/features/home/model';
import { addDays, dayTotals, FoodEntry } from '../src/lib/domain';
import { DISHES } from '../src/parser';

const TODAY = '2026-10-21';
let id = 0;
const row = (date: string, kcal: number, protein: number, extra: Partial<FoodEntry> = {}, at = `${date}T07:45:00Z`): FoodEntry => ({
  id: `e${++id}`, local_date: date, slot: 'lunch', raw_text: '', dish_id: null, custom_name: `food ${id}`, qty: 1, unit: 'count', oil_level: '',
  kcal: { low: kcal, best: kcal, high: kcal }, protein_g: { low: protein, best: protein, high: protein }, source: 'table', source_note: '', confirmed: true,
  dish_table_version: 1, created_at: at, updated_at: at, deleted_at: null, ...extra } as FoodEntry);

describe('Food card', () => {
  test('eaten and protein are the sum of counted rows; left = target - eaten', () => {
    const rows = [row(TODAY, 330, 9), row(TODAY, 540, 18.5), row(TODAY, 710, 16.5)];
    const c = foodCard(rows, 2100, 82);
    expect(c).toMatchObject({ eaten: 1580, protein: 44, left: 520, over: 0, isOver: false });
    expect(c.eaten).toBe(dayTotals(rows).kcal);
    expect(c.kcalPct).toBeCloseTo(1580 / 2100);
  });
  test('rows to review, deleted rows and failed syncs without a server copy are not counted', () => {
    const rows = [row(TODAY, 400, 10), row(TODAY, 999, 50, { needs_review: true }), row(TODAY, 500, 20, { deleted_at: '2026-10-21T08:00:00Z' }),
      row(TODAY, 300, 5, { server_failed: true } as Partial<FoodEntry>)];
    expect(foodCard(rows, 2000, 60)).toMatchObject({ eaten: 400, protein: 10, left: 1600 });
  });
  test('over target: left is 0, over is the excess, bars clamp at full', () => {
    const c = foodCard([row(TODAY, 2220, 90)], 2100, 82);
    expect(c).toMatchObject({ left: 0, over: 120, isOver: true, kcalPct: 1, proteinPct: 1 });
  });
  test('empty day: nothing eaten, everything left, no last line', () => {
    expect(foodCard([], 2100, 82)).toMatchObject({ eaten: 0, protein: 0, left: 2100, over: 0, kcalPct: 0, proteinPct: 0 });
    expect(lastLine([])).toBeNull();
  });
  test('last line: time of the latest row (IST) and the rows logged within 45 min before it', () => {
    const rows = [row(TODAY, 330, 9, { custom_name: 'poha' }, `${TODAY}T02:40:00Z`), row(TODAY, 360, 12, { custom_name: '3 roti' }, `${TODAY}T07:30:00Z`),
      row(TODAY, 250, 10, { custom_name: 'rajma' }, `${TODAY}T07:40:00Z`), row(TODAY, 200, 4, { custom_name: 'rice' }, `${TODAY}T07:45:00Z`)];
    expect(lastLine(rows)).toBe('Last: 1:15 PM · 3 roti, rajma, rice');
  });
});

describe('Last 7 days strip', () => {
  test('new user: only Today, no past days', () => {
    const s = weekStrip([], TODAY, 2100);
    expect(s.days.map((d) => d.label)).toEqual(['Today']);
    expect(s).toMatchObject({ onTarget: 0, pastDays: 0 });
  });
  test('starts at the first logged day; on / over / none per day; today shows its fill', () => {
    const rows = [row(addDays(TODAY, -3), 1900, 70), row(addDays(TODAY, -2), 1200, 40), row(addDays(TODAY, -2), 1100, 30), row(TODAY, 1050, 30),
      row(addDays(TODAY, -1), 600, 10, { needs_review: true })]; // review-only day counts as nothing logged
    const s = weekStrip(rows, TODAY, 2100);
    expect(s.days.map((d) => [d.label, d.state, d.kcal])).toEqual([['Sun', 'on', 1900], ['Mon', 'over', 2300], ['Tue', 'none', 0], ['Today', 'today', 1050]]);
    expect(s.days[3].pct).toBeCloseTo(0.5);
    expect(s).toMatchObject({ onTarget: 1, pastDays: 3 });
  });
  test('never more than 7 days, oldest first', () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(addDays(TODAY, -i), 1500, 50));
    const s = weekStrip(rows, TODAY, 2100);
    expect(s.days).toHaveLength(7);
    expect(s.days[0].date).toBe(addDays(TODAY, -6)); expect(s.days[6].label).toBe('Today');
    expect(s).toMatchObject({ onTarget: 6, pastDays: 6 });
  });
  test('a day exactly at target is on target', () => {
    expect(weekStrip([row(addDays(TODAY, -1), 2100, 50)], TODAY, 2100).onTarget).toBe(1);
  });
});

describe('Coach tip (static rules)', () => {
  const base = { kcalTarget: 2100, proteinTarget: 82, diet: 'veg' as const, dishes: DISHES };
  test('nothing logged: the intro with the targets', () => {
    expect(coachTip({ ...base, eaten: 0, kcalLeft: 2100, over: 0, proteinLeft: 82 }))
      .toBe('your goal is 2,100 kcal and 82 g protein a day. Ask me anything about food or training.');
  });
  test('protein short: names a veg pick from the table, never "katori"', () => {
    const tip = coachTip({ ...base, eaten: 1580, kcalLeft: 520, over: 0, proteinLeft: 38 });
    expect(tip).toMatch(/^you're 38 g short on protein\. .+ adds about \d+ g\.$/);
    expect(tip).not.toMatch(/katori/);
  });
  test('over target: says by how much, no red words', () => {
    expect(coachTip({ ...base, eaten: 2220, kcalLeft: 0, over: 120, proteinLeft: 0 })).toMatch(/^you're 120 kcal over today\./);
  });
  test('protein covered: kcal left', () => {
    expect(coachTip({ ...base, eaten: 1800, kcalLeft: 300, over: 0, proteinLeft: 0 })).toBe('protein is covered. 300 kcal left today.');
  });
});
