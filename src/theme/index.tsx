import { createContext, ReactNode, useContext, useMemo } from 'react';
import { StyleSheet, useColorScheme } from 'react-native';
import { ColorTokens, elevation, palette, radius, sizes, space, typeScale } from './tokens';

export type ThemePref = 'system' | 'light' | 'dark';
export interface Theme {
  dark: boolean; c: ColorTokens; space: typeof space; radius: typeof radius; type: typeof typeScale;
  sizes: typeof sizes; elev: ReturnType<typeof elevation>;
}
export const makeTheme = (dark: boolean): Theme => {
  const c = dark ? palette.dark : palette.light;
  return { dark, c, space, radius, type: typeScale, sizes, elev: elevation(dark, c.shadow) };
};
const Ctx = createContext<Theme>(makeTheme(false));

/** Follows the system setting unless the user picked light/dark in Settings. */
export function ThemeProvider({ children, pref = 'system' }: { children: ReactNode; pref?: ThemePref }) {
  const sys = useColorScheme();
  const dark = pref === 'system' ? sys === 'dark' : pref === 'dark';
  const t = useMemo(() => makeTheme(dark), [dark]);
  return <Ctx.Provider value={t}>{children}</Ctx.Provider>;
}
export const useTheme = () => useContext(Ctx);
export function makeStyles<T extends StyleSheet.NamedStyles<T>>(fn: (t: Theme) => T) {
  return () => { const t = useTheme(); return useMemo(() => StyleSheet.create(fn(t)), [t]); };
}
