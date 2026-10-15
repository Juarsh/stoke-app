import { BlurView } from 'expo-blur';
import { Tabs } from 'expo-router';
import { memo } from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { T } from '@/components/ui';
import { flags } from '@/lib/config';
import { useNavBlur } from '@/lib/perf';
import { Grad } from '@/components/Gradient';
import { useTheme } from '@/theme';

const LABEL: Record<string, string> = { index: 'Today', log: 'Log', progress: 'Progress', coach: 'Coach', community: 'Community' };
const ICON: Record<string, string> = { index: 'today', log: 'log', progress: 'progress', coach: 'coach', community: 'community' };

type BarProps = { state: { index: number; routes: { key: string; name: string }[] }; navigation: { navigate: (n: string) => void } };
/** Floating nav: equal flex tabs (cut a tab -> the rest re-space). Live blur only here, off on low-end devices. */
const FloatingBar = memo(function FloatingBar({ state, navigation }: BarProps) {
  const t = useTheme(); const ins = useSafeAreaInsets(); const blur = useNavBlur();
  const routes = state.routes.filter((r) => LABEL[r.name] && (r.name !== 'community' || flags.community));
  const inner = (
    <View style={{ flexDirection: 'row', height: t.sizes.nav, paddingHorizontal: 4, paddingVertical: 6 }}>
      {routes.map((r) => {
        const on = state.routes[state.index]?.key === r.key;
        return (
          <Pressable key={r.key} onPress={() => navigation.navigate(r.name)} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={LABEL[r.name]}
            style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3 }}>
            <View style={{ width: 52, height: 30, borderRadius: t.radius.full, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? t.c.accentFill : 'transparent' }}>
              <Icon name={ICON[r.name]} color={on ? t.c.onAccent : t.c.text2} size={20} />
            </View>
            <T v="micro" tone={on ? 'em' : 'text2'} numberOfLines={1} style={{ fontWeight: on ? '600' : '500' }}>{LABEL[r.name]}</T>
          </Pressable>
        );
      })}
    </View>
  );
  const shell = { position: 'absolute' as const, left: t.space.md, right: t.space.md, bottom: Math.max(ins.bottom, t.space.xs) + 4, borderRadius: t.radius.nav, overflow: 'hidden' as const, borderWidth: 1, borderColor: t.c.cardLine, ...t.elev.e3 };
  // blur only here; nav-solid token when blur is off (low-end / reduce transparency)
  return blur
    ? <BlurView intensity={24} tint={t.dark ? 'dark' : 'light'} style={[shell, { backgroundColor: t.c.nav }]}>{inner}</BlurView>
    : <View style={[shell, { backgroundColor: t.c.navSolid }]}>{inner}</View>;
});

export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false }} tabBar={(p) => <FloatingBar state={p.state} navigation={p.navigation as unknown as BarProps['navigation']} />}>
      <Tabs.Screen name="index" />
      <Tabs.Screen name="log" />
      <Tabs.Screen name="progress" />
      <Tabs.Screen name="coach" />
      <Tabs.Screen name="community" options={{ href: flags.community ? undefined : null }} />
    </Tabs>
  );
}
