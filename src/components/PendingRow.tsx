// Foods without numbers yet (design-notes "AI-first parser states").
// estimating: "Estimating…" in the accent under the name + a 58×14 shimmer bar where the kcal goes
//   (track → em-tint-line highlight sweeping left→right, ~1.2 s loop; static when reduce motion is on).
// offline: PENDING chip + muted "— kcal", no motion. Never a number, never counted.
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, View } from 'react-native';
import { makeStyles, useTheme } from '../theme';
import { Badge, Row, T } from './ui';

export const SHIMMER_MS = 1200;
function ShimmerBar() {
  const t = useTheme(); const s = useStyles();
  const x = useRef(new Animated.Value(0)).current;
  const [still, setStill] = useState(false);
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled?.().then(setStill).catch(() => {});
    const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', setStill);
    return () => sub?.remove?.();
  }, []);
  useEffect(() => {
    if (still) return;
    const a = Animated.loop(Animated.timing(x, { toValue: 1, duration: SHIMMER_MS, easing: Easing.linear, useNativeDriver: true }));
    a.start();
    return () => { a.stop(); x.setValue(0); };
  }, [x, still]);
  const tx = x.interpolate({ inputRange: [0, 1], outputRange: [-24, 58] });
  return (
    <View style={[s.bar, { backgroundColor: t.c.track }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Animated.View style={[s.hi, { backgroundColor: t.c.emTintLine, opacity: still ? 0 : 1, transform: [{ translateX: tx }] }]} />
    </View>
  );
}

export function PendingRow({ label, sub, state }: { label: string; sub?: string; state: 'estimating' | 'offline' }) {
  const s = useStyles();
  return (
    <Row style={s.row} accessible accessibilityLabel={`${label}, ${state === 'estimating' ? 'estimating calories' : 'pending, not counted'}`}>
      <View style={{ flex: 1 }}>
        <Row style={{ gap: 6 }}><T v="bodyStrong" numberOfLines={1}>{label}</T>{state === 'offline' ? <Badge kind="brand" label="Pending" /> : null}</Row>
        {state === 'estimating' ? <T v="caption" tone="em">Estimating…</T> : null}
        {sub ? <T v="caption" tone="muted">{sub}</T> : null}
      </View>
      {state === 'estimating' ? <ShimmerBar /> : <T v="number" tone="muted">— kcal</T>}
    </Row>
  );
}
const useStyles = makeStyles(() => ({
  row: { justifyContent: 'space-between', minHeight: 48, gap: 8 },
  bar: { width: 58, height: 14, borderRadius: 7, overflow: 'hidden' },
  hi: { width: 24, height: 14, borderRadius: 7 },
}));
