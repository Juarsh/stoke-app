// rg6 F1 / PE: the edit sheet offers only the units the server saves as confirmed, from the SERVER's data: units pulled
// with its dish table (GET /v1/dishes supported_units, stored on the phone), else the pulled dishes.json's
// supported_units (cmd/dishes-pull, same table version), else the seed copy of the backend golden. The app's own rule
// (parser.unitRule, a mirror of Go parser.SupportedUnits) must agree with all of them. No units: [] (never all 7).
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DISHES, parser, UNITS } from '../src/parser';

const copy = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/data/supported-units.json'), 'utf8')) as Record<string, string[]>;
const REPO = process.env.BACKEND ?? path.join(__dirname, '../../calorie-tracker');
const GOLDEN = 'internal/parser/testdata/supported_units.json';
const backend = (() => {
  try { return execFileSync('git', ['-C', REPO, 'show', `HEAD:${GOLDEN}`], { stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch { return null; }
})();

const rule = (id: string) => UNITS.filter((u) => parser.unitRule(id, u));
test('every dish: pulled table units (dishes.json supported_units) == the app rule == the seed copy', () => {
  expect(Object.keys(copy).sort()).toEqual(DISHES.map((d) => d.id).sort());
  for (const d of DISHES as (typeof DISHES[number] & { supported_units?: string[] })[]) {
    expect([d.id, d.supported_units]).toEqual([d.id, rule(d.id)]);
    expect([d.id, d.supported_units]).toEqual([d.id, copy[d.id]]);
  }
  const got = Object.fromEntries(DISHES.map((d) => [d.id, parser.supportedUnits(d.id)]));
  expect(got).toEqual(copy);
});
test('the phone uses the server data: pulled > table > seed; a dish with none has no units (never all 7)', () => {
  try {
    parser.setPulledUnits({ dal: ['katori'] });
    expect(parser.supportedUnits('dal')).toEqual(['katori']); // pulled wins
    expect(parser.unitSupported('dal', 'spoon')).toBe(false);
    parser.setPulledUnits(null);
    expect(parser.supportedUnits('dal')).toEqual(copy.dal);
    expect(parser.unitsFor('kodo_khichdi')).toBeNull(); // not on the phone at all
    expect(parser.supportedUnits('kodo_khichdi')).toEqual([]);
    expect(UNITS.some((u) => parser.unitSupported('kodo_khichdi', u))).toBe(false);
    parser.setPulledUnits({ kodo_khichdi: ['katori', 'spoon', 'plate', 'gram'] });
    expect(parser.supportedUnits('kodo_khichdi')).toEqual(['katori', 'spoon', 'plate', 'gram']);
  } finally { parser.setPulledUnits(null); }
});
test('the rule: only UNITS, never empty, the dish\'s own unit included (fats: spoon / gram)', () => {
  for (const d of DISHES) {
    const us = rule(d.id);
    expect(us.length).toBeGreaterThan(0);
    expect(us.every((u) => UNITS.includes(u))).toBe(true);
    expect(parser.unitSupported(d.id, 'litre')).toBe(false);
  }
  expect(parser.supportedUnits('dal')).not.toContain('piece');
  expect(parser.supportedUnits('veg_biryani')).not.toContain('spoon');
});
(backend ? test : test.skip)('the copy is byte-identical to the backend golden at HEAD (BACKEND=<backend worktree>)', () => {
  expect(fs.readFileSync(path.join(__dirname, '../src/data/supported-units.json'), 'utf8')).toBe(backend);
});
