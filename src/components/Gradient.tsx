import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';
import { useTheme } from '../theme';

let gid = 0;
/** Absolute-fill linear gradient (135° by default). Static, cheap. */
export const Grad = memo(function Grad({ colors, angle135 = true }: { colors: string[]; angle135?: boolean }) {
  const id = `lg${++gid}`;
  return (
    <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" preserveAspectRatio="none">
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2={angle135 ? '1' : '0'} y2="1">
          {colors.map((c, i) => <Stop key={i} offset={colors.length === 1 ? 0 : i / (colors.length - 1)} stopColor={c} />)}
        </LinearGradient>
      </Defs>
      <Rect width="100%" height="100%" fill={`url(#${id})`} />
    </Svg>
  );
});

/** Static radial background glows (emerald top-left, teal top-right, saffron bottom); drawn once per screen, no blur. */
/** v3.2: background glows removed (only the ring has a gradient): a solid page background instead. */
export const Glows = memo(function Glows() {
  const t = useTheme();
  return <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: t.c.bg }]} />;
});
export const GlowsV4 = memo(function GlowsV4() {
  const { c } = useTheme();
  const g = (id: string, cx: string, cy: string, col: string) => (
    <RadialGradient id={id} cx={cx} cy={cy} rx="70%" ry="45%" fx={cx} fy={cy}>
      <Stop offset="0" stopColor={col} /><Stop offset="1" stopColor={col} stopOpacity={0} />
    </RadialGradient>
  );
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Svg width="100%" height="100%">
        <Defs>{g('g1', '0%', '0%', c.glow1)}{g('g2', '50%', '100%', c.glow2)}{g('g3', '100%', '5%', c.glow3)}</Defs>
        <Rect width="100%" height="100%" fill={c.bg} />
        <Rect width="100%" height="100%" fill="url(#g1)" />
        <Rect width="100%" height="100%" fill="url(#g3)" />
        <Rect width="100%" height="100%" fill="url(#g2)" />
      </Svg>
    </View>
  );
});
