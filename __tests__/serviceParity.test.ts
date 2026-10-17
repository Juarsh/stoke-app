import fs from 'fs';
import path from 'path';
import { parseLocal, serverConfirm } from '../src/lib/parseLocal';
import { counted, hasKcal, reopenRejected, reviewEntry, FoodEntry } from '../src/lib/domain';
import { pickItem, coachPicks } from '../src/lib/coach';
import { DISHES, oneTap, parser } from '../src/parser';
import golden from '../src/data/service-golden.json';

// Reference outputs from the Go food.Service.Parse decision (no AI, no remembered foods) at backend 1c617da:
// scripts/golden/service/main.go over scripts/golden/service-cases.json (gold-safe, hand-written meals).
type G = { in: string; items: { dish_id: string; needs_confirmation: boolean; one_tap_ok?: boolean; kcal: { best: number } }[] | null };
const k = (i: { dish_id: string; needs_confirmation: boolean; one_tap_ok?: boolean; kcal: { best: number } }) => `${i.dish_id}|nc=${!!i.needs_confirmation}|ot=${!!i.one_tap_ok}|${i.kcal.best}`;

describe('offline confirm == server confirm (trailing qty, cooking style, missing side)', () => {
  test.each((golden as G[]).map((g) => [g.in, g] as const))('%s', (_in, g) => {
    expect(parseLocal(g.in).items.filter((i) => i.dish_id).map(k)).toEqual((g.items ?? []).map(k));
  });
  test('worst case: 200g chicken breast grilled never one-taps', () => {
    const it = parseLocal('200g chicken breast grilled').items[0];
    expect(it.needs_confirmation).toBe(true); expect(it.one_tap_ok).toBe(false); expect(oneTap(it)).toBe(false);
  });
  test('missing side and blocking trailing qty also confirm', () => {
    for (const m of ['sambar', '1 katori chole', 'idli 2 sambar 1 katori']) expect([m, parseLocal(m).items.some((i) => i.one_tap_ok)]).toEqual([m, false]);
    expect(parseLocal('dosa 2 sambar').items.find((i) => i.dish_id === 'dosa')!.one_tap_ok).toBe(false); // count_between
  });
  test('plain confident meals still one-tap', () => { expect(parseLocal('2 roti').items[0].one_tap_ok).toBe(true); });
  test('Coach instant Log uses the same server rule', () => {
    for (const p of coachPicks(DISHES, 900, 60, 'nonveg')) {
      const it = pickItem(p, (x) => { const r = parser.parse(x); return { items: serverConfirm(x, r), unmatched: r.unmatched }; }, oneTap);
      if (it) expect(parseLocal(p.label).items[0].one_tap_ok).toBe(true);
    }
  });
});

describe('review rows never show or confirm 0 kcal', () => {
  const it0 = { ...parser.parse('2 roti').items[0], kcal: { low: 0, best: 0, high: 0 } };
  test('hasKcal', () => { expect(hasKcal(it0)).toBe(false); expect(hasKcal(parser.parse('2 roti').items[0])).toBe(true); expect(hasKcal(undefined)).toBe(false); });
  test('review entries are out of totals (Coach maths uses counted)', () => {
    const e = reviewEntry(it0, { slot: 'lunch', raw_text: 'x', local_date: '2026-10-16', tableVersion: 3, id: 'a' });
    expect(counted(e)).toBe(false);
    const r = reopenRejected({ ...e, needs_review: false, confirmed: true } as FoodEntry, 'x');
    expect(counted(r)).toBe(false);
  });
  test('UI and store guards', () => {
    const rv = fs.readFileSync(path.join(__dirname, '../src/app/review.tsx'), 'utf8');
    expect(fs.readFileSync(path.join(__dirname, '../src/components/KcalRow.tsx'), 'utf8')).toMatch(/— kcal · needs review/); expect(rv).toMatch(/const sum = reviewSummary\(rows\);/);
    expect(fs.readFileSync(path.join(__dirname, '../src/lib/store.tsx'), 'utf8')).toMatch(/if \(!canConfirm\(it\)\) return \{ reason: CHOOSE_FIRST_REASON \};\n\s+if \(!hasKcal\(it\)\) return \{ reason: NO_KCAL_REASON \};/); // refused: the row stays in Review with the reason
  });
});

describe('privacy: backup, export, delete', () => {
  const src = (f: string) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  test('Android backup off', () => { expect(src('app.config.ts')).toMatch(/allowBackup: false/); });
  test('no user export carries sex (share is a day image of counted totals, no profile fields)', () => {
    const share = src('src/app/share.tsx');
    expect(share).not.toMatch(/\bsex\b|profile\./);
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === 'data' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]);
    for (const f of walk(path.join(__dirname, '../src'))) expect([f, /writeAsStringAsync|text\/csv|\.csv\b/.test(fs.readFileSync(f, 'utf8'))]).toEqual([f, false]);
  });
  test('delete account overwrites the whole on-device store (profile incl. sex) immediately', () => {
    const st = src('src/lib/store.tsx');
    expect(st).toMatch(/deleteAll: async \(\) => \{ await api\.deleteMe\(\)\.catch\(\(\) => \{\}\); await kv\.set\(KEY, JSON\.stringify\(EMPTY\)\)/);
    expect(st).toMatch(/const EMPTY: Persisted = \{[^}]*profile: null/);
  });
});
