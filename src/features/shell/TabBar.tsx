import { memo } from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { T } from '@/components/ui';
import { useTheme } from '@/theme';

/** full-b2 nav, in this order: Home · Food · + · Train · Progress (spec §2). No Habits or Coach tab. */
export const TABS = [
  { name: 'index', label: 'Home', icon: 'home' },
  { name: 'food', label: 'Food', icon: 'food' },
  { name: '+' },
  { name: 'train', label: 'Train', icon: 'train' },
  { name: 'progress', label: 'Progress', icon: 'prog' },
] as const;

type BarProps = {
  state: { index: number; routes: { key: string; name: string }[] };
  navigation: { navigate: (n: string) => void };
  onPlus: () => void;
};
/** Docked bar: surface + 1px top line; active tab = text colour, honey-text icon and an 18×3 honey underline.
 * The + is honey in dark, and an ink fill with a honey icon in light. Hidden routes (log, coach, …) keep no tab lit. */
export const TabBar = memo(function TabBar({ state, navigation, onPlus }: BarProps) {
  const t = useTheme(); const ins = useSafeAreaInsets();
  const current = state.routes[state.index]?.name;
  return (
    <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, paddingBottom: ins.bottom, backgroundColor: t.c.nav, borderTopWidth: 1, borderTopColor: t.c.lineSoft }}
      accessibilityRole="tablist">
      <View style={{ flexDirection: 'row', height: t.sizes.nav, paddingHorizontal: 6, paddingTop: 8, alignItems: 'flex-start' }}>
        {TABS.map((tab) => {
          if (tab.name === '+') {
            return (
              <Pressable key="+" onPress={onPlus} accessibilityRole="button" accessibilityLabel="Quick add"
                style={{ width: t.sizes.navPlus, height: t.sizes.navPlus, marginTop: -4, marginHorizontal: 4, borderRadius: t.radius.tile, alignItems: 'center', justifyContent: 'center',
                  backgroundColor: t.c.navPlus, elevation: 4, shadowColor: '#1F1A24', shadowOpacity: 0.16, shadowRadius: 10, shadowOffset: { width: 0, height: 3 } }}>
                <Icon name="plus" color={t.c.onNavPlus} size={26} strokeWidth={2.4} />
              </Pressable>
            );
          }
          const on = current === tab.name;
          return (
            <Pressable key={tab.name} onPress={() => navigation.navigate(tab.name)} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={tab.label}
              style={{ flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center', gap: 3 }}>
              <Icon name={tab.icon} color={on ? t.c.accentText : t.c.muted} size={22} strokeWidth={1.9} />
              <T v="label" tone={on ? 'text' : 'muted'} numberOfLines={1} style={{ fontSize: 12 }}>{tab.label}</T>
              <View style={{ width: 18, height: 3, borderRadius: 2, backgroundColor: on ? t.c.honeyEdge : 'transparent' }} />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
});
