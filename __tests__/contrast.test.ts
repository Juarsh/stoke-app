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
const PLAIN: K[] = ['bg', 'card', 'card2'];
// text token -> backgrounds it is drawn on (from the components; see ui.tsx tones)
const USES: [K, K[]][] = [
  ['text', [...PLAIN, 'tint', 'tintGold', 'coach1']], ['text2', [...PLAIN, 'tint', 'coach1']], ['muted', PLAIN],
  ['em', [...PLAIN, 'tint', 'coach1']], ['emChip', [...PLAIN, 'tint']], ['accentText', [...PLAIN, 'tint']],
  ['gold', [...PLAIN, 'tintGold']], ['accentText', ['coach1', 'coach2', 'coach3']], ['onCoach', ['coach1', 'coach2', 'coach3']],
  ['ai', ['aiBg', ...PLAIN]], ['danger', PLAIN], ['delete', PLAIN], ['warn', PLAIN], ['steps', PLAIN], ['freeze', PLAIN],
  ['onGrad', ['accentFill']], ['onAccent', ['accentFill']], ['onCheck', ['check']], ['popText', ['popBg']],
];

for (const theme of ['light', 'dark'] as const) {
  const p = palette[theme] as P;
  const base = parse(p.bg as string);
  const solid = (k: K) => over(parse(p[k] as string), base);
  const rows = USES.flatMap(([fg, bgs]) => bgs.map((bg) => [fg, bg] as const));
  // light 'over' is only drawn on cards (off-card it falls back to text2); dark 'over' is drawn anywhere
  if (theme === 'dark') rows.push(...(['coach1', 'coach2', 'coach3'] as K[]).map((bg) => ['goldOnGrad', bg] as const));
  rows.push(...(theme === 'light' ? (['card', 'card2'] as K[]) : PLAIN).map((bg) => ['over', bg] as const));
  test.each(rows)(`${theme}: %s on %s >= 4.5:1`, (fg, bg) => {
    const r = ratio(over(parse(p[fg] as string), solid(bg)), solid(bg));
    expect({ fg, bg, ok: r >= 4.5, r: Math.round(r * 100) / 100 }).toMatchObject({ ok: true });
  });
}
test('goldOnGrad is dark-only (#F8DA9C); light uses accentText #A8361F on #FFE3DC', () => {
  expect('goldOnGrad' in palette.light).toBe(false); expect(palette.dark.goldOnGrad).toBe('#F8DA9C');
  expect(palette.light.accentText).toBe('#A8361F'); expect(palette.light.coach1).toBe('#FFE3DC');
  expect(Math.round(ratio(parse('#A8361F'), parse('#FFE3DC')) * 100) / 100).toBeGreaterThanOrEqual(5.3);
});
