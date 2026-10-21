// The backend is the source of truth for the dish table and parser rules. The app's copies must equal the backend's
// committed files at the commit they were synced from (src/data/SOURCE_COMMIT, written by scripts/sync-dishes.sh).
// Never compared against whatever HEAD the backend checkout happens to be on: that checkout moves with other work.
// To take newer backend data: scripts/sync-dishes.sh with REF=<backend commit> (which also updates SOURCE_COMMIT).
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const REPO = process.env.BACKEND ?? path.join(__dirname, '../../calorie-tracker');
const app = (f: string) => JSON.parse(fs.readFileSync(path.join(__dirname, '../src/data', f), 'utf8'));
const backend = (ref: string, f: string) => JSON.parse(execFileSync('git', ['-C', REPO, 'show', `${ref}:${f}`]).toString());
const ref = fs.readFileSync(path.join(__dirname, '../src/data/SOURCE_COMMIT'), 'utf8').trim();
const hasRef = (() => {
  if (!fs.existsSync(path.join(REPO, '.git'))) return false;
  try { execFileSync('git', ['-C', REPO, 'cat-file', '-e', `${ref}^{commit}`], { stdio: 'ignore' }); return true; } catch { return false; }
})();
if (!hasRef) console.warn(`rules-sync skipped: backend commit ${ref} (src/data/SOURCE_COMMIT) is not in ${REPO}`);

(hasRef ? describe : describe.skip)(`app data == backend data at the synced commit ${ref}`, () => {
  test.each([['rules.json', 'internal/parser/rules.json'], ['dishes.json', 'internal/dishes/dishes.json']])(
    '%s matches the backend at the synced commit', (a, b) => expect(app(a)).toEqual(backend(ref, b)));
});
