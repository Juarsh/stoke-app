// Designer's final tokens (design-notes.md v3, light + dark). The ONLY place
// colours, type, spacing, radius and elevation are defined.
// glass* are placeholders until the bold redesign tokens land (tinted, NO live blur on cards).
export const palette = {
  light: {
    bg: '#F6F4EF', surface: '#FFFFFF', surface2: '#F3F1EB', surface3: '#ECE9E1', line: '#E4E0D6',
    text: '#16201B', text2: '#3A4540', muted: '#5C6862',
    primary: '#0F5C45', primary2: '#2E9A72', primarySoft: '#E5EFEA', primaryText: '#0B4835', onPrimary: '#FFFFFF',
    accent: '#8F5C0A', accent2: '#E5A93A', accentSoft: '#FBF0DC',
    steps: '#2D6A9F', steps2: '#6BA6D6',
    info: '#2D6A9F', infoSoft: '#E8F0F7', infoText: '#1E4B73',
    ai: '#6A4C9C', aiSoft: '#F1EDF8', aiText: '#4A3475',
    danger: '#A8322A', over: '#6B6F6D', track: '#ECE9E1',
    popBg: '#1E2622', popText: '#F2F4F3', scrim: 'rgba(14,17,16,0.45)',
    glass: 'rgba(255,255,255,0.72)', glassBorder: 'rgba(228,224,214,0.9)', navGlass: 'rgba(255,255,255,0.86)', shareBgStart: '#FBF8F1', shareBgEnd: '#F1EADB', shadow: '#0E1110',
  },
  dark: {
    bg: '#0E1110', surface: '#161A18', surface2: '#1C211F', surface3: '#242A27', line: '#2A312D',
    text: '#E8ECEA', text2: '#C3CBC7', muted: '#98A39D',
    primary: '#5CC097', primary2: '#8FD9B7', primarySoft: '#1B2E26', primaryText: '#A6E3C7', onPrimary: '#06231A',
    accent: '#E3B661', accent2: '#F0CF8E', accentSoft: '#2C2517',
    steps: '#7FB2DE', steps2: '#AFCFEC',
    info: '#7FB2DE', infoSoft: '#182532', infoText: '#B5D3EE',
    ai: '#B49BE0', aiSoft: '#251F33', aiText: '#D3C4F0',
    danger: '#E8877F', over: '#9EA3A0', track: '#242A27',
    popBg: '#2C3430', popText: '#F2F4F3', scrim: 'rgba(0,0,0,0.6)',
    glass: 'rgba(22,26,24,0.72)', glassBorder: 'rgba(42,49,45,0.9)', navGlass: 'rgba(22,26,24,0.9)', shareBgStart: '#121715', shareBgEnd: '#0B0E0D', shadow: '#000000',
  },
} as const;
export type ColorTokens = { [K in keyof typeof palette.light]: string };

export const space = { xxs: 4, xs: 8, sm: 12, md: 16, lg: 24, xl: 32, xxl: 48, screen: 16, cardV: 12, cardH: 14, gap: 10 } as const;
export const radius = { chip: 10, field: 14, button: 16, card: 18, sheet: 28, popover: 12, full: 999 } as const;

const fam = { regular: 'Inter_400Regular', medium: 'Inter_500Medium', semibold: 'Inter_600SemiBold', bold: 'Inter_700Bold', black: 'Inter_800ExtraBold' };
export const fonts = fam;
export const typeScale = {
  display: { fontSize: 30, lineHeight: 36, letterSpacing: -0.6, fontFamily: fam.black },
  title: { fontSize: 22, lineHeight: 28, letterSpacing: -0.44, fontFamily: fam.bold },
  headline: { fontSize: 17, lineHeight: 24, fontFamily: fam.bold },
  bodyStrong: { fontSize: 14, lineHeight: 20, fontFamily: fam.semibold },
  button: { fontSize: 15, lineHeight: 20, fontFamily: fam.semibold },
  body: { fontSize: 14, lineHeight: 20, fontFamily: fam.regular },
  label: { fontSize: 12.5, lineHeight: 16, fontFamily: fam.medium },
  caption: { fontSize: 12, lineHeight: 16, fontFamily: fam.regular },
  micro: { fontSize: 10.5, lineHeight: 14, letterSpacing: 0.3, fontFamily: fam.semibold },
} as const;

/** Light: soft shadows (Android elevation 1/3/8). Dark: no shadows, elevation via lighter surfaces. */
export const elevation = (dark: boolean, color: string) => {
  const mk = (e: number, r: number, o: number, y: number) =>
    dark ? {} : { elevation: e, shadowColor: color, shadowOpacity: o, shadowRadius: r, shadowOffset: { width: 0, height: y } };
  return { e1: mk(1, 8, 0.06, 2), e2: mk(3, 24, 0.08, 8), e3: mk(8, 40, 0.14, 16) };
};
export const sizes = { ring: 96, ringStroke: 9, chip: 28, touch: 48, nav: 68 } as const;
