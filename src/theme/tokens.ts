// full-b2 tokens (spec-frozen-v1 §1, design/unified/full-b2 build.py CSS). The only place colours, fonts, type,
// spacing, radius and elevation live. Older semantic names (em, accentFill, cardLine, …) are kept as roles so
// existing screens re-skin without code changes; new screens should prefer the B2 role names (honey, food, train, …).
/** B2 brand roles, one token each. HARD RULES: honey (accentFill) is never text in light mode (text uses accentText
 * #8A5410); over target is warm grey, never red or terracotta; one honey main action per screen. */
export const BRAND = {
  light: {
    accentText: '#8A5410',   // honey as text (links, Change)
    accentFill: '#E3A44A',   // honey: main action fill
    honeyEdge: '#A87020',    // 1.5px edge on honey buttons sitting on light surfaces (3:1)
    ringEnd: '#E3A44A',      // no gradients in B2
    onAccent: '#241A0C', accentTint: '#F6EAD6', accentTintLine: '#A87020', accentGlow: 'rgba(31,26,36,0.16)',
    streak: '#8A5410', streakTint: '#F6EAD6', streakBar: '#8A5410',
    warn: '#7A5A00',         // always with ⚠ (carried over; B2 adds no hue for it)
    delete: '#433B45',       // neutral; always trash icon + the word "Delete"
    over: '#6E655C',         // over target: warm grey
  },
  dark: {
    accentText: '#EDBB78', accentFill: '#E8B26A', honeyEdge: '#E8B26A', ringEnd: '#E8B26A',
    onAccent: '#241A0C', accentTint: '#2D2520', accentTintLine: '#E8B26A', accentGlow: 'rgba(0,0,0,0.4)',
    streak: '#EDBB78', streakTint: '#2D2520', streakBar: '#9A7A4A',
    warn: '#E0B84A', delete: '#D2C9BE', over: '#A89E92',
  },
};
const L = BRAND.light, D = BRAND.dark;
const light = {
  bg: '#F7F2EA', glow1: 'rgba(0,0,0,0)', glow2: 'rgba(0,0,0,0)', glow3: 'rgba(0,0,0,0)', // B2 has no background glows
  card: '#FFFCF7', card2: '#F0E9DE',
  /** card-line: border of tappable cards and inputs (3:1 on card); lineSoft = B2 --line (card borders, dividers) */
  cardLine: '#7A7064', lineSoft: '#E6DDD0', cardHighlight: 'rgba(255,255,255,0)',
  nav: '#FFFCF7', navSolid: '#FFFCF7',
  text: '#1F1A24', text2: '#433B45', muted: '#6E655C', over: L.over,
  em: L.accentText, emChip: L.accentText, em2: L.accentFill, tint: L.accentTint, emTintLine: L.accentTintLine,
  accentText: L.accentText, accentFill: L.accentFill, delete: L.delete, honeyEdge: L.honeyEdge,
  grad1: L.accentFill, grad2: L.accentFill, grad3: L.accentFill, onAccent: L.onAccent, accentTint: L.accentTint, onGrad: L.onAccent,
  coach1: L.accentTint, coach2: L.accentTint, coach3: L.accentTint, onCoach: '#1F1A24', tileBg: '#F0E9DE', tileIcon: '#433B45', iconStroke: '#A3462F', iconTint: '#F3DED6',
  gold: L.streak, gradGold1: '#E3A44A', gradGold2: '#E3A44A', tintGold: L.streakTint, streakBar: L.streakBar,
  arc1: L.accentFill, arc2: L.accentFill, arc3: L.ringEnd,
  steps: '#433B45', stepsBar1: '#6E655C', stepsBar2: '#433B45',
  ai: '#433B45', aiBg: '#F0E9DE', // AI = neutral 'Estimate' chip
  danger: L.delete, track: '#EBE3D7',
  onCoachFill: 'rgba(36,26,12,0.08)', check: '#1F1A24', onCheck: '#FFFCF7', freeze: '#376F63',
  /** review card text/icon, always with ⚠ */
  warn: L.warn, warnTint: '#FBF0D3', warnTintLine: '#EBD9A6',
  scrim: 'rgba(10,8,12,0.48)', popBg: '#221C2B', popText: '#F6F1EA', shadow: '#1F1A24', glowBtn: L.accentGlow,
  tile: [['#F0E9DE', '#E3A44A'], ['#F0E9DE', '#3F7F72'], ['#F0E9DE', '#B5503F'], ['#F0E9DE', '#6E655C'], ['#F0E9DE', '#433B45']] as string[][],
  shareBg1: '#F7F2EA', shareBg2: '#F0E9DE',
  // B2 roles
  food: '#B5503F', foodText: '#A3462F', train: '#3F7F72', trainText: '#376F63', sageFill: '#376F63', stateLine: '#8C8276',
  ink: '#221C2B', inkText: '#F6F1EA', inkMuted: '#BDB3A9', inkLine: '#3A3144', // dark "feat" workout card (honey button)
  sheet: '#FFFCF7', sheetLine: '#E6DDD0', sheetTile: '#F0E9DE', handle: '#E6DDD0',
  navPlus: '#221C2B', onNavPlus: '#E3A44A', // light: ink fill + honey icon
};
type Palette = typeof light & { goldOnGrad?: string };
/** goldOnGrad is dark-only (light uses accentText for those texts). */
const dark: Palette & { goldOnGrad: string } = {
  bg: '#15121B', glow1: 'rgba(0,0,0,0)', glow2: 'rgba(0,0,0,0)', glow3: 'rgba(0,0,0,0)',
  card: '#1F1A24', card2: '#2A2430',
  cardLine: '#9C9286', lineSoft: '#322B37', cardHighlight: 'rgba(255,255,255,0.06)',
  nav: '#1A1620', navSolid: '#1A1620',
  text: '#F3EEE7', text2: '#D2C9BE', muted: '#A89E92', over: D.over,
  em: D.accentText, emChip: D.accentText, em2: D.accentFill, tint: D.accentTint, emTintLine: D.accentTintLine,
  accentText: D.accentText, accentFill: D.accentFill, delete: D.delete, honeyEdge: D.honeyEdge,
  grad1: D.accentFill, grad2: D.accentFill, grad3: D.accentFill, onAccent: D.onAccent, accentTint: D.accentTint, onGrad: D.onAccent,
  coach1: D.accentTint, coach2: D.accentTint, coach3: D.accentTint, onCoach: '#F3EEE7', tileBg: '#2A2430', tileIcon: '#D2C9BE', iconStroke: '#E89A84', iconTint: '#3A2A2A',
  gold: D.streak, goldOnGrad: '#EDBB78', gradGold1: '#E8B26A', gradGold2: '#E8B26A', tintGold: D.streakTint, streakBar: D.streakBar,
  arc1: D.accentFill, arc2: D.accentFill, arc3: D.ringEnd,
  steps: '#D2C9BE', stepsBar1: '#A89E92', stepsBar2: '#D2C9BE',
  ai: '#D2C9BE', aiBg: '#2A2430',
  danger: D.delete, track: '#2F2834',
  onCoachFill: 'rgba(255,255,255,0.10)', check: '#F3EEE7', onCheck: '#15121B', freeze: '#8CC7B8',
  warn: D.warn, warnTint: '#2A2312', warnTintLine: '#4A3D1C',
  scrim: 'rgba(0,0,0,0.78)', popBg: '#2A2430', popText: '#F3EEE7', shadow: '#000000', glowBtn: D.accentGlow,
  tile: light.tile.map(([, fg]) => ['#2A2430', fg]),
  shareBg1: '#15121B', shareBg2: '#1F1A24',
  food: '#E89A84', foodText: '#E89A84', train: '#8CC7B8', trainText: '#8CC7B8', sageFill: '#8CC7B8', stateLine: '#8F857A',
  ink: '#2A2238', inkText: '#F6F1EA', inkMuted: '#C1B7C6', inkLine: '#3D3350',
  sheet: '#2A2430', sheetLine: '#3A3340', sheetTile: '#352E3B', handle: '#4A4250', // dark sheets: surface #2A2430 + 1px top highlight
  navPlus: '#E8B26A', onNavPlus: '#241A0C', // dark: honey fill
};
const alias = (p: Palette): Palette & ReturnType<typeof aliasOf> => aliasOf(p);
const aliasOf = (p: Palette) => ({
  ...p,
  surface: p.card, surface2: p.card2, surface3: p.track, line: p.cardLine, lineSoft: (p as { lineSoft: string }).lineSoft,
  primary: p.em, primary2: p.em2, primarySoft: p.tint, primaryText: p.emChip, onPrimary: p.onGrad,
  accent: p.gold, accent2: p.gradGold1, accentSoft: p.tintGold, steps2: p.stepsBar1,
  info: p.freeze, infoSoft: p.tint, infoText: p.text2, aiSoft: p.aiBg, aiText: p.ai,
  glass: p.card, glassBorder: p.cardLine, navGlass: p.navSolid, shareBgStart: p.shareBg1, shareBgEnd: p.shareBg2,
});
export const palette = { light: alias(light), dark: alias(dark) };
export type ColorTokens = ReturnType<typeof alias>;

export const space = { xxs: 4, xs: 8, sm: 12, md: 16, lg: 24, xl: 32, xxl: 48, screen: 18, cardV: 14, cardH: 16, gap: 10 } as const;
export const radius = { chip: 999, tile: 14, card: 22, field: 14, button: 14, sheet: 28, popover: 14, nav: 0, full: 999 } as const;

/**
 * React Native has no font fallback stacks, so <T>/<Field> switch to the
 * matching Noto Sans Devanagari weight whenever the text contains Devanagari
 * (see devaFamily). That also applies inside view-shot share cards.
 */
export const fonts = {
  inter: { 400: 'Inter_400Regular', 500: 'Inter_500Medium', 600: 'Inter_600SemiBold', 700: 'Inter_700Bold' },
  grotesk: { 400: 'SpaceGrotesk_400Regular', 500: 'SpaceGrotesk_500Medium', 600: 'SpaceGrotesk_600SemiBold', 700: 'SpaceGrotesk_700Bold' },
  dm: { 400: 'DMSans_400Regular', 500: 'DMSans_500Medium', 600: 'DMSans_600SemiBold', 700: 'DMSans_700Bold' },
  deva: { 400: 'NotoSansDevanagari_400Regular', 500: 'NotoSansDevanagari_500Medium', 600: 'NotoSansDevanagari_600SemiBold', 700: 'NotoSansDevanagari_700Bold' },
} as const;
type W = 400 | 500 | 600 | 700;
// full-b2: DM Sans for display (g) and UI (i) text alike
const g = (w: W) => fonts.dm[w];
const i = (w: W) => fonts.dm[w];
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
for (const set of [fonts.inter, fonts.grotesk, fonts.dm]) for (const [w, f] of Object.entries(set)) famWeight.set(f, Number(w) as W);
const DEVA = /[\u0900-\u097F]/;
export const hasDevanagari = (s: unknown): boolean => {
  if (typeof s === 'string') return DEVA.test(s);
  if (Array.isArray(s)) return s.some(hasDevanagari);
  return false;
};
export const devaFamily = (family: string) => fonts.deva[famWeight.get(family) ?? 400];

/** Light: one soft shadow per card. Dark: no drop shadows (tint steps + top highlight). Buttons keep an emerald glow. */
export const elevation = (dark: boolean, c: { shadow: string; glowBtn: string }) => ({
  e1: {}, // full-b2 cards are flat (1px line border, no shadow)
  e2: dark ? {} : { elevation: 4, shadowColor: c.shadow, shadowOpacity: 0.14, shadowRadius: 20, shadowOffset: { width: 0, height: 12 } },
  e3: dark ? {} : { elevation: 8, shadowColor: c.shadow, shadowOpacity: 0.16, shadowRadius: 30, shadowOffset: { width: 0, height: 16 } },
  glow: { elevation: 6, shadowColor: c.glowBtn, shadowOpacity: 1, shadowRadius: 12, shadowOffset: { width: 0, height: 10 } },
});
export const sizes = { hero: 236, heroStroke: 18, ring: 96, ringStroke: 9, arc: 250, arcStroke: 14, chip: 32, touch: 48, nav: 70, tile: 44, navPlus: 54 } as const;
