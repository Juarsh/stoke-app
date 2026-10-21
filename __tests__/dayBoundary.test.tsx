// One day boundary on the phone (spec §4, 4 AM): the log day an entry is saved under (local_date sent to the server) is
// the day Home, the 7-day strip, Today, the streak and the coach call "today". Checked at 00:30, 03:59 and 04:00 IST.
import React from 'react';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { act, create } from 'react-test-renderer';
import { dayOf, FoodEntry, slotFor } from '../src/lib/domain';
import { buildEntries, newTrayItem } from '../src/features/logfood/model';
import { foodCard, weekStrip } from '../src/features/home/model';
import { parser } from '../src/parser';

const mockStore = { entries: [] as FoodEntry[], queue: [], steps: {}, profile: { kcalTarget: 2000, proteinTarget: 60, diet: 'veg' } };
jest.mock('@/lib/store', () => ({ useStore: () => mockStore }));
import { useDay } from '../src/lib/useDay';

const ist = (s: string) => new Date(`${s}+05:30`);
let n = 0; const newId = () => `d${++n}`;
type Day = ReturnType<typeof useDay>;
function dayAt(now: Date): Day {
  jest.useFakeTimers({ now });
  let out!: Day;
  const Probe = () => { out = useDay(); return null; };
  act(() => { create(<Probe />); });
  jest.useRealTimers();
  return out;
}
const logAt = (at: Date) => buildEntries([newTrayItem(parser.dishById('roti')!, 'k', 'piece', 2)], at, { now: at, newId }).entries[0];

describe.each([
  ['00:30', '2026-10-21T00:30:00', '2026-10-20', 'dinner'],
  ['03:59', '2026-10-21T03:59:00', '2026-10-20', 'dinner'],
  ['04:00', '2026-10-21T04:00:00', '2026-10-21', 'breakfast'],
])('at %s IST', (_label, t, day, slot) => {
  const now = ist(t);
  test(`the log day is ${day}; the entry is saved with local_date ${day}`, () => {
    expect(dayOf(now)).toBe(day);
    const e = logAt(now);
    expect(e.local_date).toBe(day);
    expect(e.slot).toBe(slot);
    expect(slotFor(now)).toBe(slot);
  });
  test('Home / Today (useDay), the streak and the 7-day strip count it on that same day', () => {
    const e = logAt(now);
    mockStore.entries = [e];
    const d = dayAt(now);
    expect(d.date).toBe(day);
    expect(d.entries.map((x) => x.id)).toEqual([e.id]);
    expect(d.tot.kcal).toBe(Math.round(e.kcal.best));
    expect(d.streak.current).toBe(1);
    expect(foodCard(d.entries, 2000, 60).eaten).toBe(Math.round(e.kcal.best));
    const strip = weekStrip(mockStore.entries, d.date, 2000);
    const today = strip.days.find((x: { state: string }) => x.state === 'today') as { kcal: number };
    expect(today.kcal).toBe(Math.round(e.kcal.best));
    expect(d.kcalLeft).toBe(2000 - Math.round(e.kcal.best)); // the coach picks use this
  });
});

test('a 03:59 entry is not "today" at 04:00 (the new day starts empty)', () => {
  mockStore.entries = [logAt(ist('2026-10-21T03:59:00'))];
  const d = dayAt(ist('2026-10-21T04:00:00'));
  expect(d.date).toBe('2026-10-21');
  expect(d.entries).toEqual([]);
});

test('one helper: no screen or lib computes "today" any other way', () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(p) ? [p] : []; });
  const src = join(__dirname, '..', 'src');
  const offenders = walk(src).filter((p) => !p.endsWith(join('lib', 'domain.ts')))
    .flatMap((p) => readFileSync(p, 'utf8').split('\n').map((l, i) => ({ p, i, l })))
    // localDate(x) is only the calendar date for the time wheel's day column
    .filter(({ l, p }) => /localDate\(\s*\)|toISOString\(\)\.slice\(0, ?10\)|setHours\(0/.test(l) || (/\blocalDate\(/.test(l) && !p.endsWith(join('logfood', 'model.ts'))));
  expect(offenders.map((o) => `${o.p}:${o.i + 1}`)).toEqual([]);
});

test('steps are read from the log day’s 4 AM start (the day Home saves them under)', () => {
  const { dayStartAt } = jest.requireActual('../src/lib/domain');
  expect(dayStartAt('2026-10-21').toISOString()).toBe('2026-10-20T22:30:00.000Z'); // 04:00 IST
});
