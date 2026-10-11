import { BlurView } from 'expo-blur';
import { Tabs } from 'expo-router';
import { memo } from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { T } from '@/components/ui';
import { flags } from '@/lib/config';
import { allowLiveBlur } from '@/lib/perf';
import { useTheme } from '@/theme';

const LABEL: Record<string, string> = { index: 'Today', log: 'Log', progress: 'Progress', coach: 'Coach', community: 'Community' };
const ICON: Record<string, string> = { index: 'today', log: 'log', progress: 'progress', coach: 'coach', community: 'community' };

type BarProps = { state: { index: number; routes: { key: string; name: string }[] }; navigation: { navigate: (n: string) => void } };
/** Floating nav: equal flex tabs (cut a tab -> the rest re-space). Live blur only here, off on low-end devices. */
const FloatingBar = memo(function FloatingBar({ state, navigation }: BarProps) {
  const t = useTheme(); const ins = useSafeAreaInsets();
  const routes = state.routes.filter((r) => LABEL[r.name] && (r.name !== 'community' || flags.community));
  const inner = (
    <View style={{ flexDirection: 'row', height: t.sizes.nav }}>
      {routes.map((r) => {
        const on = state.routes[state.index]?.key === r.key;
        return (
          <Pressable key={r.key} onPress={() => navigation.navigate(r.name)} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={LABEL[r.name]}
            style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2 }}>
            <View style={{ width: 52, height: 28, borderRadius: t.radius.full, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? t.c.primarySoft : 'transparent' }}>
              <Icon name={ICON[r.name]} color={on ? t.c.primaryText : t.c.muted} />
            </View>
            <T v="micro" tone={on ? 'primaryText' : 'muted'}>{LABEL[r.name]}</T>
          </Pressable>
        );
      })}
    </View>
  );
  const shell = { position: 'absolute' as const, left: t.space.sm, right: t.space.sm, bottom: Math.max(ins.bottom, t.space.xs), borderRadius: t.radius.card + 6, overflow: 'hidden' as const, borderWidth: 1, borderColor: t.c.glassBorder, ...t.elev.e3 };
  return allowLiveBlur
    ? <BlurView intensity={40} tint={t.dark ? 'dark' : 'light'} style={[shell, { backgroundColor: t.c.glass }]}>{inner}</BlurView>
    : <View style={[shell, { backgroundColor: t.c.navGlass }]}>{inner}</View>;
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
