import { memo } from 'react';
import { View } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import { useTheme } from '../theme';
import { T } from './ui';

/** 270° gradient arc (gold → emerald → teal) around the big "kcal left" number. */
export const HeroArc = memo(function HeroArc({ eaten, target, kcalLeft }: { eaten: number; target: number; kcalLeft: number }) {
  const t = useTheme();
  const S = t.sizes.arc, sw = t.sizes.arcStroke, r = (S - sw) / 2, cx = S / 2, cy = S / 2;
  const start = 135, sweep = 270;
  const pt = (deg: number) => { const a = (deg * Math.PI) / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; };
  const arc = (from: number, to: number) => {
    const [x1, y1] = pt(from), [x2, y2] = pt(to);
    return `M ${x1} ${y1} A ${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2} ${y2}`;
  };
  const pct = target > 0 ? Math.min(1, Math.max(0, eaten / target)) : 0;
  const over = kcalLeft < 0;
  return (
    <View style={{ alignItems: 'center', justifyContent: 'center', height: S * 0.86 }}
      accessible accessibilityLabel={over ? `${-kcalLeft} calories over target of ${target}` : `${kcalLeft} calories left of ${target}`}>
      <Svg width={S} height={S} style={{ position: 'absolute', top: 0 }}>
        <Defs>
          <LinearGradient id="arc" x1="0" y1="1" x2="1" y2="0">
            <Stop offset="0" stopColor={t.c.arc1} /><Stop offset="0.5" stopColor={t.c.arc2} /><Stop offset="1" stopColor={t.c.arc3} />
          </LinearGradient>
        </Defs>
        <Path d={arc(start, start + sweep)} stroke={t.c.track} strokeWidth={sw} fill="none" strokeLinecap="round" />
        {pct > 0 ? <Path d={arc(start, start + Math.max(1, sweep * pct))} stroke={over ? t.c.over : 'url(#arc)'} strokeWidth={sw} fill="none" strokeLinecap="round" /> : null}
      </Svg>
      {over ? (
        // light `over` grey is not allowed on the bare background, so "over" uses text colours here
        <><T v="display">{-kcalLeft}</T><T v="bodyStrong" tone="text2">kcal over · target {target}</T></>
      ) : (
        <><T v="hero">{kcalLeft}</T><T v="caption" tone="muted">kcal left of {target.toLocaleString('en-IN')} ⓘ</T></>
      )}
    </View>
  );
});

export const Bar = memo(function Bar({ pct, from, to }: { pct: number; from: string; to: string }) {
  const t = useTheme();
  return (
    <View style={{ height: 6, borderRadius: 3, backgroundColor: t.c.track, overflow: 'hidden' }}>
      <Svg width={`${Math.min(100, Math.max(0, pct * 100))}%`} height={6}>
        <Defs><LinearGradient id={`b${from}${to}`.replace(/[^a-z0-9]/gi, '')} x1="0" y1="0" x2="1" y2="0"><Stop offset="0" stopColor={from} /><Stop offset="1" stopColor={to} /></LinearGradient></Defs>
        <Path d="M0 0 H1000 V6 H0 Z" fill={`url(#${`b${from}${to}`.replace(/[^a-z0-9]/gi, '')})`} />
      </Svg>
    </View>
  );
});
