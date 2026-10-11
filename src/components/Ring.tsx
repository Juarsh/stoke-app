import { View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Stop } from 'react-native-svg';
import { useTheme } from '../theme';
import { T } from './ui';

/** 96dp gradient ring with round caps on the `track` colour. */
export function Ring({ value, max, from, to, big, caption, a11y }: { value: number; max: number; from: string; to: string; big: string; caption: string; a11y: string }) {
  const t = useTheme();
  const size = t.sizes.ring, sw = t.sizes.ringStroke, r = (size - sw) / 2, C = 2 * Math.PI * r;
  const pct = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const id = `g${from.slice(1)}${to.slice(1)}`;
  return (
    <View style={{ alignItems: 'center', gap: 4, flex: 1 }} accessible accessibilityLabel={a11y}>
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <Svg width={size} height={size} style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}>
          <Defs><LinearGradient id={id} x1="0" y1="0" x2="1" y2="1"><Stop offset="0" stopColor={from} /><Stop offset="1" stopColor={to} /></LinearGradient></Defs>
          <Circle cx={size / 2} cy={size / 2} r={r} stroke={t.c.track} strokeWidth={sw} fill="none" />
          {pct > 0 ? <Circle cx={size / 2} cy={size / 2} r={r} stroke={`url(#${id})`} strokeWidth={sw} fill="none" strokeLinecap="round" strokeDasharray={`${C * pct} ${C}`} /> : null}
        </Svg>
        <T v="headline">{big}</T>
      </View>
      <T v="caption" tone="muted" style={{ textAlign: 'center' }}>{caption}</T>
    </View>
  );
}
