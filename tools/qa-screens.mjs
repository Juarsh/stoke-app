// Headless Chrome screenshots of the web build at 390x844 (QA only; native may differ, see README).
import { chromium } from '/tmp/qa/node_modules/playwright-core/index.mjs';
import { execFileSync } from 'node:child_process';
const BASE = process.env.BASE ?? 'http://localhost:5055';
const OUT = process.env.OUT ?? '/workspace/calorie/design/qa';
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const wait = (p, ms = 1500) => p.waitForTimeout(ms);
// Every shot is stamped with the commit the web export was built from (file name + corner label).
const SHA = process.env.QA_SHA ?? execFileSync('git', ['rev-parse', '--short', 'HEAD']).toString().trim();
async function shot(p, name, opts = {}) {
  await p.evaluate((sha) => {
    let el = document.getElementById('qa-sha');
    if (!el) { el = document.createElement('div'); el.id = 'qa-sha'; document.body.appendChild(el); }
    el.textContent = sha;
    el.style.cssText = 'position:fixed;right:4px;top:2px;z-index:99999;font:10px monospace;padding:1px 4px;border-radius:3px;background:rgba(0,0,0,.55);color:#fff;pointer-events:none';
  }, SHA);
  await p.screenshot({ path: `${OUT}/${name}-${SHA}.png`, ...opts });
}
async function page(theme, variant = '', viewport = { width: 390, height: 844 }) {
  const state = execFileSync('npx', ['tsx', 'tools/qa-seed.ts', theme, variant]).toString();
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: theme });
  await ctx.addInitScript((s) => { if (!localStorage.getItem('app-state-v1')) localStorage.setItem('app-state-v1', s); }, state);
  return ctx.newPage();
}
for (const theme of ['light', 'dark']) {
  const p = await page(theme);
  await p.goto(BASE + '/'); await wait(p, 3000);
  await shot(p, `today-${theme}`);
  await p.goto(BASE + '/progress'); await wait(p, 2000);
  await shot(p, `progress-${theme}`);
  const say = async (txt) => { await p.goto(BASE + '/log'); await wait(p, 1500); await p.getByLabel('What did you eat?').fill(txt); };
  // v3.2 frames: log-estimating / log-all-estimates (mock AI answers after EXPO_PUBLIC_MOCK_AI_DELAY ms)
  await say('2 roti, kombucha, sushi, 1 banana'); await wait(p, 1400);
  await shot(p, `log-estimating-${theme}`);
  await say('kombucha, sushi, hummus'); await wait(p, 5500);
  await shot(p, `log-all-estimates-${theme}`);
  await say('2 chapatii dal, 8 plate momos, paneer lababdar, quinoa bowl'); await wait(p, 5500);
  await shot(p, `log-ai-check-${theme}`, { fullPage: true });
  // confirm batch + inline estimates (design-notes v3.2 Oct 15); one_tap_ok only ever comes from the server
  for (const [txt, name] of [['2 roti, dal, bhindi, thukpa', 'log-confirm-batch'], ['bhel puri, thukpa', 'log-confirm-none'], ['thukpa', 'log-ai-estimate-row'],
    ['8 plates momos, 6 katori dal', 'log-unit-mismatch'], ['bhel puri', 'log-bhel-unverified']]) {
    await say(txt); await wait(p, 5500);
    await shot(p, `${name}-${theme}`);
  }
  // estimating + failed AI rows (Oct 15)
  await say('2 roti, dal, thukpa'); await wait(p, 1400);
  await shot(p, `log-ai-estimating-${theme}`);
  await say('2 roti, zanthu'); await wait(p, 5500);
  await shot(p, `log-estimate-failed-${theme}`);
  for (const [w, name] of [['qauserlimit', 'user-limit'], ['qauserlimitnt', 'user-limit-no-time'], ['qadaily', 'daily-limit'], ['qadailynt', 'daily-limit-no-time']]) {
    await say(`2 roti, ${w}`); await wait(p, 5500);
    await shot(p, `log-failed-${name}-${theme}`);
  }
  // Add while estimating -> confident items saved, estimating ones go to items to review
  await say('2 roti, granola'); await wait(p, 1400);
  await p.getByRole('button', { name: /estimating/ }).click(); await wait(p, 2000);
  await shot(p, `today-review-${theme}`);
  {
    await say('२ रोटी, दाल और थोड़ा घी'); await wait(p, 1200);
    await shot(p, `log-hindi-${theme}`, { fullPage: true });
  }
  for (const [route, name] of [['/remembered', 'remembered'], ['/coach', 'coach'], ['/community', 'community']]) {
    await p.goto(BASE + route); await wait(p, 1500);
    await shot(p, `${name}-${theme}`);
  }
  await p.context().close();
  // onboarding only shows for a signed-in user without a profile
  const o = await page(theme, 'noprofile');
  await o.goto(BASE + '/onboarding'); await wait(o, 2000);
  await shot(o, `onboarding-${theme}`);
  await o.context().close();
  // Review: AI estimates each with their own 'Add · N kcal'; failed row Enter kcal; biryani Choose type; no bulk button
  const rv = await page(theme, 'aireview');
  await rv.goto(BASE + '/review'); await wait(rv, 2000);
  await shot(rv, `review-ai-rows-${theme}`, { fullPage: true });
  for (let i = 0; i < 3; i++) { await rv.getByText(/^Add · [0-9,]+ kcal$/).first().click(); await wait(rv, 400); }
  await shot(rv, `review-ai-rows-after-3-taps-${theme}`, { fullPage: true });
  if (await rv.getByText(/All look right/).count()) throw new Error('bulk button shown with no eligible rows');
  await rv.context().close();
  // Today: one entry that could not be synced (row scrolled into view; its kcal still counts in the ring)
  const sf = await page(theme, 'syncfail');
  await sf.goto(BASE + '/'); await wait(sf, 3000);
  const sfRow = sf.getByRole('button', { name: /couldn’t sync this/i });
  if ((await sfRow.count()) !== 1) throw new Error(`expected 1 sync-failed row, got ${await sfRow.count()}`);
  await sfRow.scrollIntoViewIfNeeded(); await wait(sf, 500);
  await shot(sf, `today-sync-retry-${theme}`);
  await sf.context().close();
  // rg6 F1 / F4: the server's version on the row (review + reason, "Saved as …"), "Pick a type to save this." -> the types,
  // and the edit sheet offering only the dish's own units (dal: katori, spoon, plate, gram)
  const g = await page(theme, 'rg6');
  await g.goto(BASE + '/'); await wait(g, 3000);
  const pick = g.getByRole('button', { name: /: Pick a type to save this\.$/ });
  if ((await pick.count()) !== 1) throw new Error(`expected 1 pick-a-type row, got ${await pick.count()}`);
  if ((await g.getByText('Not counted yet: dal isn’t measured in pieces.', { exact: false }).count()) < 1) throw new Error('no server review note on Today');
  await pick.scrollIntoViewIfNeeded(); await wait(g, 500);
  await shot(g, `today-server-version-${theme}`, { fullPage: true });
  await pick.click(); await wait(g, 1200);
  await shot(g, `today-pick-type-${theme}`);
  if ((await g.getByText('Check amount', { exact: true }).count()) < 1) throw new Error('no Check amount row on Today');
  await g.goto(BASE + '/review'); await wait(g, 2000);
  await shot(g, `review-server-note-${theme}`, { fullPage: true });
  if ((await g.getByText('Check amount', { exact: true }).count()) < 1) throw new Error('no Check amount row in Review');
  await g.getByRole('button', { name: /^Check: read as dal/ }).first().click(); await wait(g, 1200);
  const chips = await g.getByTestId('unit-chips').innerText();
  if (/piece|glass|count/.test(chips)) throw new Error(`dal sheet offers units it doesn't come in: ${chips}`);
  await shot(g, `edit-sheet-units-dal-${theme}`);
  await g.context().close();
  // rg7: a save the server 500ed three times ("Couldn’t sync this. Tap to retry", not counted); in Review a newly pulled dish's
  // type pick (the server's types), an older-table dal-in-plates note and the empty-unit line; Log + edit sheet refusing
  // a table row over 10,000 kcal ("That’s too much for one entry. Try a smaller amount.")
  const h = await page(theme, 'rg7');
  await h.goto(BASE + '/'); await wait(h, 3000);
  // rg8: plus a delete flagged after 3x 5xx ("(deleted)", "Not deleted on the server yet.") and a custom name as typed
  const fail = h.getByRole('button', { name: /couldn’t sync this/i });
  if ((await fail.count()) !== 2) throw new Error(`expected 2 sync-failed rows (save + delete), got ${await fail.count()}`);
  if ((await h.getByText('Not deleted on the server yet.', { exact: false }).count()) < 1) throw new Error('no flagged delete on Today');
  if ((await h.getByText('akarsh_special_shake', { exact: false }).count()) < 1) throw new Error('custom name not shown as typed');
  await fail.first().scrollIntoViewIfNeeded(); await wait(h, 500);
  await shot(h, `today-5xx-flag-${theme}`);
  await h.goto(BASE + '/review'); await wait(h, 2000);
  for (const t of ['Pick a type to save this.', 'Not counted yet: dal isn’t measured in plates.', 'Not counted yet: Check the amount and add it again.'])
    if ((await h.getByText(t, { exact: false }).count()) < 1) throw new Error(`Review lacks: ${t}`);
  if ((await h.getByRole('button', { name: /^Zarda pulao, 390 calories$/ }).count()) < 1) throw new Error('no zarda type choice in Review');
  if ((await h.getByText(/measured in s\b/).count()) > 0) throw new Error('"measured in s." rendered');
  await shot(h, `review-pulled-type-${theme}`, { fullPage: true });
  await h.goto(BASE + '/log'); await wait(h, 2000);
  await h.getByLabel('What did you eat?').fill('100 roti'); await wait(h, 1500);
  await h.getByRole('button', { name: /^100 pieces, 11,000 calories$/ }).click(); await wait(h, 1000); // the user means 100: Add can't save it
  await shot(h, `log-too-much-${theme}`);
  await h.getByRole('button', { name: /Double-tap to edit$/ }).first().click(); await wait(h, 1200);
  if ((await h.getByTestId('too-much').count()) < 1) throw new Error('no too-much line in the edit sheet');
  await shot(h, `edit-sheet-too-much-${theme}`);
  await h.context().close();
  // step 2 at 360x800: 'Start logging' must be fully above the fold (fails QA otherwise)
  const o2 = await page(theme, 'noprofile', { width: 360, height: 800 });
  await o2.goto(BASE + '/onboarding'); await wait(o2, 2000);
  await o2.getByText('Next', { exact: true }).click(); await wait(o2, 800);
  await shot(o2, `onboarding-2-360x800-${theme}`);
  const box = await o2.getByText('Start logging', { exact: true }).boundingBox();
  if (!box || box.y + box.height > 800) throw new Error(`Start logging below the fold at 360x800 (${theme}): ${JSON.stringify(box)}`);
  console.log(`fold ok ${theme}: Start logging bottom ${Math.round(box.y + box.height)} / 800`);
  await o2.context().close();
}
await browser.close();
