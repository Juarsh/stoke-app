// rg6 F1: the edit sheet offers only the units the server saves as confirmed. The rule (parser.unitSupported) must give
// exactly the backend's list (Go parser.SupportedUnits, testdata/supported_units.json); src/data/supported-units.json is
// a byte-identical copy of it (re-copy it when the backend's golden changes).
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

test('every dish: the app rule == the backend list (copy)', () => {
  expect(Object.keys(copy).sort()).toEqual(DISHES.map((d) => d.id).sort());
  const got = Object.fromEntries(DISHES.map((d) => [d.id, parser.supportedUnits(d.id)]));
  expect(got).toEqual(copy);
});
test('the rule: only UNITS, never empty, the dish\'s own unit included (fats: spoon / gram)', () => {
  for (const d of DISHES) {
    const us = parser.supportedUnits(d.id);
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
