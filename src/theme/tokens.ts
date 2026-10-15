// Designer's FINAL tokens: design-notes.md v4 (bold redesign, dark-first).
// The only place colours, fonts, type, spacing, radius and elevation live.
// Older semantic names (surface, primarySoft, …) are kept as aliases onto v4 values.
/** Brand roles, one token each (design-notes.md "Accent pop (v3.2)", final + verified).
 * HARD RULE: accentFill (#FF5A3C) is never used for text or icons in light mode (tab labels, links included):
 * text uses accentText; anything ON a fill uses onAccent. */
export const BRAND = {
  light: {
    accentText: '#A8361F',   // small coral text, links, "Estimating…", Change
    accentFill: '#FF5A3C',   // primary button, ring start, active-tab pill
    ringEnd: '#FF4F7B',      // ring: coral -> pink, the ONLY gradient in the app
    onAccent: '#2A0B04', accentTint: '#FFE3DC', accentTintLine: '#FFC9BB', accentGlow: 'rgba(255,90,60,0.30)',
    streak: '#7B2A9A', streakTint: '#F3E3FA',
    warn: '#7A5A00',         // always with ⚠
    delete: '#3B433F',       // neutral; always trash icon + the word "Delete"
    over: '#626664',         // over target: ring + "kcal over" text, neutral grey
  },
  dark: {
    accentText: '#FF8A70', accentFill: '#FF7A5C', ringEnd: '#FF5C8A',
    onAccent: '#2A0B04', accentTint: '#3A1C15', accentTintLine: '#5A2A1E', accentGlow: 'rgba(255,122,92,0.35)',
    streak: '#E2B4FF', streakTint: '#2A1A33',
    warn: '#E0B84A', delete: '#C2CAC6', over: '#9EA3A0',
  },
};
const L = BRAND.light, D = BRAND.dark;
const light = {
  bg: '#F6F1E7', glow1: 'rgba(46,170,130,0.22)', glow2: 'rgba(232,170,70,0.20)', glow3: 'rgba(30,140,150,0.14)',
  card: 'rgba(255,253,248,0.90)', card2: 'rgba(255,255,255,0.96)', cardLine: 'rgba(20,60,45,0.10)', cardHighlight: 'rgba(255,255,255,0.9)',
  nav: 'rgba(255,255,255,0.82)', navSolid: '#FFFDF8',
  text: '#111A16', text2: '#34413B', muted: '#56625C', over: L.over,
  em: L.accentText, emChip: L.accentText, em2: L.accentFill, tint: L.accentTint, emTintLine: L.accentTintLine,
  accentText: L.accentText, accentFill: L.accentFill, delete: L.delete,
  grad1: L.accentFill, grad2: L.accentFill, grad3: L.accentFill, onAccent: L.onAccent, accentTint: L.accentTint, onGrad: L.onAccent,
  // Fill/coach card: solid accent tint (no gradients except the ring)
  coach1: L.accentTint, coach2: L.accentTint, coach3: L.accentTint, onCoach: '#111A16', tileBg: '#EFEAE0', tileIcon: '#34413B', iconStroke: '#A8361F', iconTint: '#FFCCC0', // food icons (v3.2): never accentFill
  gold: L.streak, gradGold1: '#F6CF7E', gradGold2: '#E9A93B', tintGold: L.streakTint,
  arc1: L.accentFill, arc2: L.accentFill, arc3: L.ringEnd,
  steps: '#1E6AA1', stepsBar1: '#9CC8F2', stepsBar2: '#3A6FC4',
  ai: '#34413B', aiBg: '#EFEAE0', // AI = neutral 'Estimate' chip
  danger: L.delete, track: 'rgba(20,60,45,0.10)',
  onCoachFill: 'rgba(42,11,4,0.08)', check: '#111A16', onCheck: '#FFFFFF', freeze: '#1E6AA1',
  /** review card text/icon, always with ⚠ */
  warn: L.warn,
  scrim: 'rgba(8,11,10,0.45)', popBg: '#1A201D', popText: '#F1F4F2', shadow: '#0E1110', glowBtn: L.accentGlow,
  tile: [['#F6CF7E', '#E07A2E'], ['#7FE3C0', '#13A07A'], ['#F4A3A3', '#C9485B'], ['#9CC8F2', '#3A6FC4'], ['#D9C2F5', '#7A55C2']] as string[][],
  shareBg1: '#FBF8F1', shareBg2: '#F1EADB',
};
type Palette = typeof light & { goldOnGrad?: string };
/** goldOnGrad is dark-only (light uses accentText for those texts). */
const dark: Palette & { goldOnGrad: string } = {
  bg: '#080B0A', glow1: 'rgba(19,160,122,0.30)', glow2: 'rgba(233,169,59,0.10)', glow3: 'rgba(18,124,136,0.28)',
  card: 'rgba(20,26,23,0.90)', card2: 'rgba(32,40,36,0.94)', cardLine: 'rgba(255,255,255,0.09)', cardHighlight: 'rgba(255,255,255,0.07)',
  nav: 'rgba(22,28,25,0.82)', navSolid: '#1A201D',
  text: '#F1F4F2', text2: '#C9D2CD', muted: '#9AA6A0', over: D.over,
  em: D.accentText, emChip: D.accentText, em2: D.accentFill, tint: D.accentTint, emTintLine: D.accentTintLine,
  accentText: D.accentText, accentFill: D.accentFill, delete: D.delete,
  grad1: D.accentFill, grad2: D.accentFill, grad3: D.accentFill, onAccent: D.onAccent, accentTint: D.accentTint, onGrad: D.onAccent,
  coach1: D.accentTint, coach2: D.accentTint, coach3: D.accentTint, onCoach: '#F1F4F2', tileBg: '#1F2522', tileIcon: '#C9D2CD', iconStroke: '#FF8A70', iconTint: '#3A1C15',
  gold: D.streak, goldOnGrad: '#F8DA9C', gradGold1: '#F6CF7E', gradGold2: '#E9A93B', tintGold: D.streakTint,
  arc1: D.accentFill, arc2: D.accentFill, arc3: D.ringEnd,
  steps: '#7FB8E6', stepsBar1: '#9CC8F2', stepsBar2: '#3A6FC4',
  ai: '#C9D2CD', aiBg: '#1F2522',
  danger: D.delete, track: 'rgba(255,255,255,0.08)',
  onCoachFill: 'rgba(255,255,255,0.12)', check: '#F1F4F2', onCheck: '#080B0A', freeze: '#7FB8E6',
  warn: D.warn,
  scrim: 'rgba(0,0,0,0.6)', popBg: '#202824', popText: '#F1F4F2', shadow: '#000000', glowBtn: D.accentGlow,
  tile: light.tile,
  shareBg1: '#121715', shareBg2: '#0B0E0D',
};
const alias = (p: Palette): Palette & ReturnType<typeof aliasOf> => aliasOf(p);
const aliasOf = (p: Palette) => ({
  ...p,
  surface: p.card, surface2: p.card2, surface3: p.track, line: p.cardLine,
  primary: p.em, primary2: p.em2, primarySoft: p.tint, primaryText: p.emChip, onPrimary: p.onGrad,
  accent: p.gold, accent2: p.gradGold1, accentSoft: p.tintGold, steps2: p.stepsBar1,
  info: p.freeze, infoSoft: p.tint, infoText: p.text2, aiSoft: p.aiBg, aiText: p.ai,
  glass: p.card, glassBorder: p.cardLine, navGlass: p.navSolid, shareBgStart: p.shareBg1, shareBgEnd: p.shareBg2,
});
export const palette = { light: alias(light), dark: alias(dark) };
export type ColorTokens = ReturnType<typeof alias>;

export const space = { xxs: 4, xs: 8, sm: 12, md: 16, lg: 24, xl: 32, xxl: 48, screen: 18, cardV: 14, cardH: 16, gap: 10 } as const;
export const radius = { chip: 999, tile: 14, card: 20, field: 24, button: 999, sheet: 32, popover: 14, nav: 31, full: 999 } as const;

/**
 * React Native has no font fallback stacks, so <T>/<Field> switch to the
 * matching Noto Sans Devanagari weight whenever the text contains Devanagari
 * (see devaFamily). That also applies inside view-shot share cards.
 */
export const fonts = {
  inter: { 400: 'Inter_400Regular', 500: 'Inter_500Medium', 600: 'Inter_600SemiBold', 700: 'Inter_700Bold' },
  grotesk: { 400: 'SpaceGrotesk_400Regular', 500: 'SpaceGrotesk_500Medium', 600: 'SpaceGrotesk_600SemiBold', 700: 'SpaceGrotesk_700Bold' },
  deva: { 400: 'NotoSansDevanagari_400Regular', 500: 'NotoSansDevanagari_500Medium', 600: 'NotoSansDevanagari_600SemiBold', 700: 'NotoSansDevanagari_700Bold' },
} as const;
type W = 400 | 500 | 600 | 700;
const g = (w: W) => fonts.grotesk[w];
const i = (w: W) => fonts.inter[w];
export const typeScale = {
  hero: { fontSize: 88, lineHeight: 92, letterSpacing: -2.6, fontFamily: g(700) },
  ring: { fontSize: 60, lineHeight: 64, letterSpacing: -1.8, fontFamily: g(700) },
  displayXl: { fontSize: 72, lineHeight: 74, letterSpacing: -2.2, fontFamily: g(700) },
  display: { fontSize: 52, lineHeight: 56, letterSpacing: -1.6, fontFamily: g(700) },
  displayM: { fontSize: 34, lineHeight: 38, letterSpacing: -1, fontFamily: g(700) },
  title: { fontSize: 24, lineHeight: 30, letterSpacing: -0.7, fontFamily: g(700) },
  headline: { fontSize: 18, lineHeight: 24, letterSpacing: -0.4, fontFamily: g(700) },
  number: { fontSize: 17, lineHeight: 22, letterSpacing: -0.3, fontFamily: g(700) },
  input: { fontSize: 21, lineHeight: 27, fontFamily: g(500) },
  bodyStrong: { fontSize: 14, lineHeight: 20, fontFamily: i(600) },
  button: { fontSize: 15, lineHeight: 20, fontFamily: i(700) },
  body: { fontSize: 14, lineHeight: 20, fontFamily: i(400) },
  label: { fontSize: 12.5, lineHeight: 16, fontFamily: i(600) },
  caption: { fontSize: 12, lineHeight: 16, fontFamily: i(400) },
  eyebrow: { fontSize: 11, lineHeight: 14, letterSpacing: 1.5, textTransform: 'uppercase' as const, fontFamily: i(700) },
  micro: { fontSize: 10.5, lineHeight: 14, letterSpacing: 0.4, fontFamily: i(700) },
} as const;
const famWeight = new Map<string, W>();
for (const set of [fonts.inter, fonts.grotesk]) for (const [w, f] of Object.entries(set)) famWeight.set(f, Number(w) as W);
const DEVA = /[\u0900-\u097F]/;
export const hasDevanagari = (s: unknown): boolean => {
  if (typeof s === 'string') return DEVA.test(s);
  if (Array.isArray(s)) return s.some(hasDevanagari);
  return false;
};
export const devaFamily = (family: string) => fonts.deva[famWeight.get(family) ?? 400];

/** Light: one soft shadow per card. Dark: no drop shadows (tint steps + top highlight). Buttons keep an emerald glow. */
export const elevation = (dark: boolean, c: { shadow: string; glowBtn: string }) => ({
  e1: dark ? {} : { elevation: 3, shadowColor: c.shadow, shadowOpacity: 0.1, shadowRadius: 15, shadowOffset: { width: 0, height: 10 } },
  e2: dark ? {} : { elevation: 4, shadowColor: c.shadow, shadowOpacity: 0.14, shadowRadius: 20, shadowOffset: { width: 0, height: 12 } },
  e3: dark ? {} : { elevation: 8, shadowColor: c.shadow, shadowOpacity: 0.16, shadowRadius: 30, shadowOffset: { width: 0, height: 16 } },
  glow: { elevation: 6, shadowColor: c.glowBtn, shadowOpacity: 1, shadowRadius: 12, shadowOffset: { width: 0, height: 10 } },
});
export const sizes = { hero: 236, heroStroke: 18, ring: 96, ringStroke: 9, arc: 250, arcStroke: 14, chip: 32, touch: 48, nav: 62, tile: 44 } as const;
