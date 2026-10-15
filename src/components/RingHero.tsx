// v3.2 Today hero: 236 px ring, 18 px stroke, coral -> pink gradient (the ONLY gradient in the app).
// Inside: kcal left (Space Grotesk 60), "kcal left of N", "N g protein left". Over target: neutral grey ring + "kcal over".
import { memo } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Stop } from 'react-native-svg';
import { useTheme } from '../theme';
import { T } from './ui';

export const RingHero = memo(function RingHero({ eaten, target, kcalLeft, proteinLeft }: { eaten: number; target: number; kcalLeft: number; proteinLeft: number }) {
  const t = useTheme();
  const S = t.sizes.hero, sw = t.sizes.heroStroke, r = (S - sw) / 2, C = 2 * Math.PI * r;
  const over = kcalLeft < 0;
  const pct = over ? 1 : target > 0 ? Math.min(1, Math.max(0, eaten / target)) : 0;
  const fmt = (n: number) => Math.round(n).toLocaleString('en-IN');
  return (
    <View style={{ alignItems: 'center', justifyContent: 'center', width: S, height: S, alignSelf: 'center' }} accessible
      accessibilityLabel={over ? `${fmt(-kcalLeft)} calories over target of ${fmt(target)}` : `${fmt(kcalLeft)} calories left of ${fmt(target)}, ${fmt(proteinLeft)} grams protein left`}>
      <Svg width={S + 24} height={S + 24} style={{ position: 'absolute', left: -12, top: -12 }}>
        <Defs>
          <LinearGradient id="ring" x1="1" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={t.c.arc1} /><Stop offset="1" stopColor={t.c.arc3} />
          </LinearGradient>
        </Defs>
        {t.dark && pct > 0 && !over ? [20, 10].map((g, i) => ( // design-notes v3.2: dark ring "glow 10px" (same gradient, not a new one)
          <Circle key={g} cx={S / 2 + 12} cy={S / 2 + 12} r={r} stroke="url(#ring)" strokeOpacity={i ? 0.16 : 0.08} strokeWidth={sw + g} fill="none" strokeLinecap="round"
            strokeDasharray={`${C * pct} ${C}`} transform={`rotate(-90 ${S / 2 + 12} ${S / 2 + 12})`} />
        )) : null}
        <Circle cx={S / 2 + 12} cy={S / 2 + 12} r={r} stroke={t.c.track} strokeWidth={sw} fill="none" />
        {pct > 0 ? (
          <Circle cx={S / 2 + 12} cy={S / 2 + 12} r={r} stroke={over ? t.c.over : 'url(#ring)'} strokeWidth={sw} fill="none" strokeLinecap="round"
            strokeDasharray={`${C * pct} ${C}`} transform={`rotate(-90 ${S / 2 + 12} ${S / 2 + 12})`} />
        ) : null}
      </Svg>
      {over ? (
        <><T v="ring">{fmt(-kcalLeft)}</T><T v="caption" tone="text2">kcal over · target {fmt(target)}</T></>
      ) : (
        <>
          <T v="ring">{fmt(kcalLeft)}</T>
          <T v="caption" tone="muted">kcal left of {fmt(target)}</T>
          <T v="bodyStrong" tone="text2" style={{ marginTop: 4 }}>{fmt(proteinLeft)} g protein left</T>
        </>
      )}
    </View>
  );
});
