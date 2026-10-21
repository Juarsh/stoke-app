// The sign-in screen names the app from brand.config.js (via app.config extra), never a hardcoded name.
import { readFileSync } from 'fs';
import { join } from 'path';

test('sign-in shows brand.name; no hardcoded app name in the app code', () => {
  const brand = require('../brand.config.js');
  expect(brand.name).toBe(process.env.APP_NAME || 'Stoke');
  const src = readFileSync(join(__dirname, '../src/app/sign-in.tsx'), 'utf8');
  expect(src).toMatch(/\{brand\.name\}/);
  const cfg = readFileSync(join(__dirname, '../app.config.ts'), 'utf8');
  expect(cfg).toMatch(/name: brand\.name/);
  expect(cfg).toMatch(/extra: \{\s*brand,/);
  const walk = (d: string): string[] => require('fs').readdirSync(d, { withFileTypes: true })
    .flatMap((e: { name: string; isDirectory: () => boolean }) => (e.isDirectory() ? walk(join(d, e.name)) : /\.tsx?$/.test(e.name) ? [join(d, e.name)] : []));
  expect(walk(join(__dirname, '../src')).filter((f) => /KatoriCount|Placeholder Fit/.test(readFileSync(f, 'utf8')))).toEqual([]);
});

test('Stoke ids; the Expo slug stays placeholder-fit (EAS project of the signed Expo Go link) and is not the name', () => {
  if (process.env.APP_SLUG || process.env.APP_ANDROID_PACKAGE || process.env.APP_IOS_BUNDLE_ID) return;
  const brand = require('../brand.config.js');
  expect([brand.slug, brand.androidPackage, brand.iosBundleId]).toEqual(['placeholder-fit', 'app.stokefit', 'app.stokefit']);
  if (!process.env.APP_SCHEME) expect(brand.scheme).toBe('stoke');
  expect(readFileSync(join(__dirname, '../app.config.ts'), 'utf8')).toMatch(/slug: brand\.slug/);
});
