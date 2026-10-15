import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';
import { makeStyles, useTheme } from '../theme';
import Svg, { Path } from 'react-native-svg';
import { Icon } from './Icon';
import { T } from './ui';

/** "⚠ N items to review" (spec): neutral card, warn token (no saffron), chevron, whole card tappable, >= 48dp. */
export function ReviewLink({ date, n, right }: { date: string; n: number; right?: string }) {
  const router = useRouter(); const t = useTheme(); const s = useStyles();
  const label = `${n} ${n === 1 ? 'item' : 'items'} to review`;
  return (
    <Pressable onPress={() => router.push({ pathname: '/review', params: { date } })} accessibilityRole="button"
      accessibilityLabel={`${label}. Not counted until checked.`} style={({ pressed }) => [s.card, pressed && { opacity: 0.85 }]}>
      <Svg width={20} height={20} viewBox="0 0 24 24" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Path d="M12 3.5 21.5 20h-19z" fill={t.c.warn} stroke={t.c.warn} strokeWidth={1.5} strokeLinejoin="round" />
        <Path d="M12 10v4.5M12 17.2v.3" stroke={t.c.card} strokeWidth={2} strokeLinecap="round" />
      </Svg>
      <View style={{ flex: 1 }}><T v="bodyStrong" tone="warn">{label}</T></View>
      {right ? <T v="caption" tone="text2">{right}</T> : null}
      <Icon name="chevron" color={t.c.text2} size={20} />
    </Pressable>
  );
}
const useStyles = makeStyles((t) => ({
  card: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: t.space.sm, paddingHorizontal: t.space.cardH, paddingVertical: t.space.sm,
    borderRadius: t.radius.card, backgroundColor: t.c.card, borderWidth: 1, borderColor: t.c.line },
}));
