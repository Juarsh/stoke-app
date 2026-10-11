// Headless Chrome screenshots of the web build at 390x844 (QA only; native may differ, see README).
import { chromium } from '/tmp/qa/node_modules/playwright-core/index.mjs';
import { execFileSync } from 'node:child_process';
const BASE = process.env.BASE ?? 'http://localhost:5055';
const OUT = process.env.OUT ?? '/workspace/calorie/design/qa';
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const wait = (p, ms = 1500) => p.waitForTimeout(ms);
async function page(theme) {
  const state = execFileSync('npx', ['tsx', 'tools/qa-seed.ts', theme]).toString();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: theme });
  await ctx.addInitScript((s) => { if (!localStorage.getItem('app-state-v1')) localStorage.setItem('app-state-v1', s); }, state);
  return ctx.newPage();
}
for (const theme of ['light', 'dark']) {
  const p = await page(theme);
  await p.goto(BASE + '/'); await wait(p, 3000);
  await p.screenshot({ path: `${OUT}/today-${theme}.png` });
  await p.goto(BASE + '/progress'); await wait(p, 2000);
  await p.screenshot({ path: `${OUT}/progress-${theme}.png` });
  await p.goto(BASE + '/log'); await wait(p, 2000);
  await p.getByLabel('What did you eat?').fill('2 chapatii dal, 8 plate momos, paneer lababdar, soya chaap roll, quinoa bowl');
  await wait(p, 800);
  await p.getByText('Get AI estimate').click(); await wait(p, 1200);
  await p.screenshot({ path: `${OUT}/log-ai-check-${theme}.png`, fullPage: true });
  if (theme === 'light') {
    await p.getByLabel('What did you eat?').fill('२ रोटी, दाल और थोड़ा घी');
    await wait(p, 1200);
    await p.screenshot({ path: `${OUT}/log-hindi-${theme}.png`, fullPage: true });
  }
  if (theme === 'light') { await p.goto(BASE + '/remembered'); await wait(p, 1500); await p.screenshot({ path: `${OUT}/remembered-${theme}.png` }); }
  await p.context().close();
}
await browser.close();
