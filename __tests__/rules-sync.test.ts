// The backend is the source of truth for the dish table and parser rules. This fails as soon as the app's copies
// drift from the backend's committed files (fix: scripts/sync-dishes.sh with REF=<backend commit>).
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const REPO = process.env.BACKEND ?? path.join(__dirname, '../../calorie-tracker');
const app = (f: string) => JSON.parse(fs.readFileSync(path.join(__dirname, '../src/data', f), 'utf8'));
const backend = (ref: string, f: string) => JSON.parse(execFileSync('git', ['-C', REPO, 'show', `${ref}:${f}`]).toString());
const has = fs.existsSync(path.join(REPO, '.git'));
const ref = fs.readFileSync(path.join(__dirname, '../src/data/SOURCE_COMMIT'), 'utf8').trim();

(has ? describe : describe.skip)('app data == backend data', () => {
  test.each([['rules.json', 'internal/parser/rules.json'], ['dishes.json', 'internal/dishes/dishes.json']])(
    '%s matches the backend at the synced commit', (a, b) => expect(app(a)).toEqual(backend(ref, b)));
  test.each([['rules.json', 'internal/parser/rules.json'], ['dishes.json', 'internal/dishes/dishes.json']])(
    '%s matches the backend HEAD (re-run sync-dishes when this fails)', (a, b) => expect(app(a)).toEqual(backend('HEAD', b)));
});
