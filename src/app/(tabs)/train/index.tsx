import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { Screen, T } from '@/components/ui';
import { useTheme } from '@/theme';

/** Train tab (spec §9.1, lib-train): for now only the Exercises section ("Browse exercises · how-tos"). Plans and the weekly
 * split come with item 9; Yours and "+ Add custom" with custom exercises. */
export default function Train() {
  const t = useTheme(); const router = useRouter();
  return (
    <Screen title="Train">
      <View style={{ backgroundColor: t.c.card, borderRadius: t.radius.card, borderWidth: 1, borderColor: t.c.lineSoft, overflow: 'hidden' }}>
        <T v="bodyStrong" accessibilityRole="header" style={{ fontSize: 16, paddingHorizontal: 18, paddingTop: 16, paddingBottom: 4 }}>Exercises</T>
        <Pressable onPress={() => router.push('/train/exercises')} accessibilityRole="button" accessibilityLabel="Browse exercises, how-tos"
          style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 18, opacity: pressed ? 0.85 : 1 })}>
          <Icon name="search" color={t.c.text} size={18} strokeWidth={2} />
          <T style={{ flex: 1, fontSize: 16 }}><T v="bodyStrong" style={{ fontSize: 16 }}>Browse exercises</T><T tone="muted" style={{ fontSize: 14 }}> · how-tos</T></T>
          <Icon name="chevron" color={t.c.text2} size={18} strokeWidth={2.2} />
        </Pressable>
      </View>
    </Screen>
  );
}
