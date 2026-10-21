// Colour rule: every text token, on each background it is really drawn on, in both themes, meets WCAG AA 4.5:1.
// Translucent surfaces (card, card2) are composited over the screen bg first.
import { palette } from '../src/theme/tokens';

type RGBA = [number, number, number, number];
function parse(c: string): RGBA {
  const m = c.match(/^rgba?\(([^)]+)\)$/);
  if (m) { const [r, g, b, a = '1'] = m[1].split(',').map((x) => x.trim()); return [+r, +g, +b, +a]; }
  const h = c.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
}
const over = (fg: RGBA, bg: RGBA): RGBA => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1) as RGBA;
const lum = ([r, g, b]: RGBA) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
export const ratio = (a: RGBA, b: RGBA) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

type P = (typeof palette)['light'];
type K = keyof P;
// Every text colour on every surface it could sit on (drawn today or not): screen, cards, tints, tiles, AI chip, tab bar.
const SURFACES: K[] = ['bg', 'card', 'card2', 'tint', 'tintGold', 'coach1', 'tileBg', 'aiBg', 'nav', 'navSolid', 'warnTint'];
const TEXT: K[] = ['text', 'text2', 'muted', 'em', 'emChip', 'accentText', 'gold', 'onCoach', 'ai', 'danger', 'delete', 'warn', 'steps', 'freeze', 'over'];
// "on-fill" colours only ever sit on their own fill
const ON_FILL: [K, K][] = [['onGrad', 'accentFill'], ['onAccent', 'accentFill'], ['onCheck', 'check'], ['popText', 'popBg']];

for (const theme of ['light', 'dark'] as const) {
  const p = palette[theme] as P;
  const base = parse(p.bg as string);
  // translucent surfaces composite over the screen bg (nav over bg too)
  const solid = (k: K) => over(parse(p[k] as string), base);
  const text = [...TEXT, ...(theme === 'dark' ? (['goldOnGrad'] as K[]) : [])];
  const rows: (readonly [K, K])[] = [...text.flatMap((fg) => SURFACES.map((bg) => [fg, bg] as const)), ...ON_FILL];
  test.each(rows)(`${theme}: %s on %s >= 4.5:1`, (fg, bg) => {
    const r = ratio(over(parse(p[fg] as string), solid(bg)), solid(bg));
    expect({ fg, bg, r: Math.round(r * 100) / 100, ok: r >= 4.5 }).toMatchObject({ ok: true });
  });
}
test('goldOnGrad is dark-only; light honey text is #8A5410 (full-b2), on the honey tint >= 4.5:1', () => {
  expect('goldOnGrad' in palette.light).toBe(false); expect(palette.dark.goldOnGrad).toBe('#EDBB78');
  expect(palette.light.accentText).toBe('#8A5410'); expect(palette.light.coach1).toBe('#F6EAD6');
  expect(ratio(parse('#8A5410'), parse('#F6EAD6'))).toBeGreaterThanOrEqual(4.5);
});

// Non-text UI (WCAG 1.4.11): tappable card borders and the kcal input border need 3:1 against the card.
test.each(['light', 'dark'] as const)('%s: cardLine (card border) on card >= 3:1', (theme) => {
  const p = palette[theme];
  const base = parse(p.bg as string);
  const card = over(parse(p.card as string), base);
  const r = ratio(over(parse(p.cardLine as string), card), card);
  expect({ theme, cardLine: p.cardLine, r: Math.round(r * 100) / 100, ok: r >= 3 }).toMatchObject({ ok: true });
});
test.each(['light', 'dark'] as const)('%s: muted (kcal input border) on card >= 3:1', (theme) => {
  const p = palette[theme];
  const base = parse(p.bg as string);
  const card = over(parse(p.card as string), base);
  const r = ratio(over(parse(p.muted as string), card), card);
  expect({ theme, muted: p.muted, r: Math.round(r * 100) / 100, ok: r >= 3 }).toMatchObject({ ok: true });
});
test('full-b2 lines: card-line for tappable borders, soft line for card borders and dividers', () => {
  expect([palette.light.cardLine, palette.dark.cardLine]).toEqual(['#7A7064', '#9C9286']);
  expect([palette.light.lineSoft, palette.dark.lineSoft]).toEqual(['#E6DDD0', '#322B37']);
});
