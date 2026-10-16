import fs from 'fs';
import path from 'path';
import { coachPicks, leftForToday, lighterPicks, pickItem, portionOf, suggest } from '../src/lib/coach';
import { computeTargets, MAX_DEFICIT, MIN_KCAL, Profile, serverProfile, SEX_CONST } from '../src/lib/domain';
import { stripSex } from '../src/lib/api';
import { DISHES, oneTap, parser } from '../src/parser';

const base = { goal: 'maintain' as const, age: 30, heightCm: 170, weightKg: 70, activity: 'sedentary' as const };
const bmr = (c: number) => 10 * 70 + 6.25 * 170 - 5 * 30 + c;

describe('target formula (Mifflin-St Jeor)', () => {
  test('sex constants: +5 male, -161 female, -78 prefer-not (average)', () => {
    expect(SEX_CONST).toEqual({ m: 5, f: -161, x: -78 });
    expect((SEX_CONST.m + SEX_CONST.f) / 2).toBe(SEX_CONST.x);
  });
  test.each([['m', 5], ['f', -161], ['x', -78]] as const)('%s maintenance', (sex, c) => {
    const r = computeTargets({ ...base, sex });
    expect(r.kcal).toBe(Math.round((bmr(c) * 1.2) / 10) * 10);
    expect(r.protein).toBe(84);
  });
  test('prefer-not sits between male and female', () => {
    const m = computeTargets({ ...base, sex: 'm' }).kcal, f = computeTargets({ ...base, sex: 'f' }).kcal, x = computeTargets({ ...base, sex: 'x' }).kcal;
    expect(x).toBeLessThan(m); expect(x).toBeGreaterThan(f);
  });
  test('goal adjusts and protein factor', () => {
    const g = computeTargets({ ...base, sex: 'm', goal: 'gain' });
    expect(g.kcal).toBe(Math.round((bmr(5) * 1.2 + 300) / 10) * 10); expect(g.protein).toBe(112);
  });
});

describe('guard rails', () => {
  test('daily target never below 1200 kcal', () => {
    for (const sex of ['m', 'f', 'x'] as const) for (const goal of ['lose', 'maintain', 'gain'] as const) {
      const r = computeTargets({ goal, sex, age: 90, heightCm: 120, weightKg: 30, activity: 'sedentary' });
      expect(r.kcal).toBeGreaterThanOrEqual(MIN_KCAL);
    }
    expect(MIN_KCAL).toBe(1200);
    expect(computeTargets({ goal: 'lose', sex: 'f', age: 80, heightCm: 140, weightKg: 38, activity: 'sedentary' }).kcal).toBe(1200);
  });
  test('loss goal never more than 500 kcal below maintenance', () => {
    expect(MAX_DEFICIT).toBe(500);
    for (const w of [50, 70, 100, 150]) for (const activity of ['sedentary', 'light', 'moderate', 'active'] as const) {
      const r = computeTargets({ goal: 'lose', sex: 'm', age: 30, heightCm: 180, weightKg: w, activity });
      expect(r.maintenance - r.kcal).toBeLessThanOrEqual(MAX_DEFICIT + 5); // +5: rounding to 10
      expect(r.kcal).toBeLessThan(r.maintenance);
    }
  });
});

describe('left for today', () => {
  test('under target', () => { expect(leftForToday(1850, 90, 1330, 52)).toEqual({ kcalLeft: 520, kcalOver: 0, over: false, proteinLeft: 38, proteinMet: false }); });
  test('over target: no negatives, over flag', () => { expect(leftForToday(1850, 90, 1970, 95)).toEqual({ kcalLeft: 0, kcalOver: 120, over: true, proteinLeft: 0, proteinMet: true }); });
  test('exact target and fractional protein', () => { const r = leftForToday(2000, 60.5, 2000, 20.25); expect(r.kcalLeft).toBe(0); expect(r.over).toBe(false); expect(r.proteinLeft).toBe(40.3); });
});

describe('coach picks', () => {
  const safe = (k: number, p: number, d: 'veg' | 'egg' | 'nonveg') => coachPicks(DISHES, k, p, d, 12).filter((s) => pickItem(s, (x) => parser.parse(x), oneTap)).slice(0, 3);
  test.each([[520, 38, 'veg'], [300, 10, 'nonveg'], [1500, 80, 'egg'], [0, 0, 'veg']] as const)('3 safe picks for %i kcal %s', (k, p, d) => {
    const ps = safe(k, p, d);
    expect(ps).toHaveLength(3);
    for (const s of ps) {
      if (k >= 80) expect(s.kcal).toBeLessThanOrEqual(k); else expect(s.kcal).toBeLessThanOrEqual(150);
      if (d === 'veg') expect(s.dish.diet ?? 'veg').toBe('veg');
      const it = pickItem(s, (x) => parser.parse(x), oneTap)!;
      expect(it.dish_id).toBe(s.dish.id); expect(Math.round(it.kcal.best)).toBe(s.kcal); // logged number = shown number
    }
  });
  test('over budget switches to lighter picks', () => { expect(coachPicks(DISHES, 0, 0, 'veg')).toEqual(lighterPicks(DISHES, 'veg')); expect(coachPicks(DISHES, 500, 30, 'veg')).toEqual(suggest(DISHES, 500, 30, 'veg')); });
  test('pickItem rejects anything not a confident same-dish read', () => {
    const s = suggest(DISHES, 520, 38, 'veg')[0];
    expect(pickItem(s, () => ({ items: [], unmatched: [] }), () => true)).toBeNull();
    expect(pickItem(s, (x) => parser.parse(x), () => false)).toBeNull();
    expect(pickItem(s, (x) => { const r = parser.parse(x); return { ...r, unmatched: ['x'] }; }, oneTap)).toBeNull();
    expect(pickItem({ ...s, kcal: s.kcal + 50 }, (x) => parser.parse(x), oneTap)).toBeNull();
  });
  test('portion text', () => {
    const d = DISHES.find((x) => x.unit === 'count')!;
    expect(portionOf({ dish: d, qty: 2, kcal: 1, protein: 1, label: '' })).toBe('2 pieces');
    expect(portionOf({ dish: { ...d, unit: 'katori' }, qty: 1, kcal: 1, protein: 1, label: '' })).toBe('1 katori');
  });
});

describe('sex stays on this phone', () => {
  const prof: Profile = { goal: 'lose', sex: 'f', age: 30, heightCm: 160, weightKg: 60, activity: 'light', diet: 'veg', kcalTarget: 1600, proteinTarget: 96, stepsTarget: 8000, addStepKcal: false, showKcalOnCards: true };
  test('server profile drops sex, keeps the target', () => {
    const sp = serverProfile(prof) as Record<string, unknown>;
    expect('sex' in sp).toBe(false); expect(sp.kcalTarget).toBe(1600); expect(sp.proteinTarget).toBe(96);
    expect(JSON.stringify(stripSex(prof))).not.toMatch(/"sex"/);
  });
  test('no API request body ever carries sex (fetch spy over every api call path)', async () => {
    const jest_ = jest; jest_.resetModules();
    jest_.doMock('../src/lib/config', () => ({ config: { mock: false, apiUrl: 'http://x', mockAi: false } }));
    const bodies: string[] = [];
    const g = global as unknown as { fetch: unknown };
    const old = g.fetch;
    g.fetch = jest_.fn(async (_u: string, init: { body?: string }) => { if (init?.body) bodies.push(init.body); return { ok: true, status: 204, json: async () => ({}), text: async () => '' }; });
    try {
      const { createApi } = require('../src/lib/api');
      const api = createApi(() => 't');
      await api.putProfile(prof);
      await api.putProfile({ ...prof, nested: 1 });
      expect(bodies.length).toBeGreaterThanOrEqual(2);
      for (const b of bodies) { expect(b).not.toMatch(/"sex"/); expect(b).toMatch(/kcalTarget/); }
    } finally { g.fetch = old; jest_.dontMock('../src/lib/config'); }
  });
  test('store sends serverProfile; sync queue only carries entries; no analytics or log calls exist', () => {
    const src = (f: string) => fs.readFileSync(path.join(__dirname, '../src', f), 'utf8');
    expect(src('lib/store.tsx')).toMatch(/putProfile\(serverProfile\(profile\)\)/);
    expect(src('lib/syncQueue.ts')).not.toMatch(/profile|sex/i);
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === 'data' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]);
    for (const f of walk(path.join(__dirname, '../src')).filter((f) => /\.tsx?$/.test(f))) {
      const s = fs.readFileSync(f, 'utf8');
      expect([f, /console\.(log|warn|error|info|debug)|analytics|Sentry|crashlytics|logEvent/.test(s)]).toEqual([f, false]);
    }
  });
});
