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
async function page(theme, variant = '') {
  const state = execFileSync('npx', ['tsx', 'tools/qa-seed.ts', theme, variant]).toString();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: theme });
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
}
await browser.close();
