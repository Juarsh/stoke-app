import { Pressable, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { T } from '@/components/ui';
import type { Exercise } from '@/lib/exercises';
import { useTheme } from '@/theme';
import { metaLine } from './model';

/** List row (§9.2): thumbnail slot, name, muted "Back · Cable", chevron. The thumbnail is a neutral tile until our own
 * drawings ship (no third-party art). */
export function ExerciseRow({ e, first, onPress }: { e: Exercise; first: boolean; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${e.name}, ${metaLine(e)}. How-to`}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 74, paddingHorizontal: 14, paddingVertical: 10,
        borderTopWidth: first ? 0 : 1, borderTopColor: t.c.lineSoft, opacity: pressed ? 0.85 : 1 })}>
      <View style={{ width: 44, height: 44, borderRadius: 10, backgroundColor: t.c.sheetTile, alignItems: 'center', justifyContent: 'center' }}
        accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Icon name="train" color={t.c.muted} size={22} strokeWidth={1.8} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <T v="bodyStrong" style={{ fontSize: 17 }} numberOfLines={2}>{e.name}</T>
        <T tone="muted" style={{ fontSize: 14 }}>{metaLine(e)}</T>
      </View>
      <Icon name="chevron" color={t.c.text2} size={18} strokeWidth={2.2} />
    </Pressable>
  );
}
