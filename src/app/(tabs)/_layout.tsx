import { Tabs } from 'expo-router';
import { useState } from 'react';
import { PlusSheet } from '@/features/shell/PlusSheet';
import { TabBar } from '@/features/shell/TabBar';

/** App shell (build-plan item 1): Home · Food · + · Train · Progress. The + opens the Add sheet.
 * log (Log food flow) and coach stay as routes reached from the + sheet / Home; community is parked (no entry point in v1). */
export default function TabsLayout() {
  const [plus, setPlus] = useState(false);
  return (
    <>
      <Tabs screenOptions={{ headerShown: false }}
        tabBar={(p) => (
          // SDK 58 (expo-router 58): tab bar props no longer carry `navigation`; switch tabs by route key with navigateToTab.
          <TabBar state={p.state} onPlus={() => setPlus(true)}
            navigation={{ navigate: (n: string) => { const r = p.state.routes.find((x) => x.name === n); if (r) p.navigateToTab(r.key); } }} />
        )}>
        <Tabs.Screen name="index" />
        <Tabs.Screen name="food" />
        <Tabs.Screen name="train" />
        <Tabs.Screen name="progress" />
        {/* Reached from the + sheet / Home, never shown in the bar: TabBar draws only its own TABS. No href: null here,
            since expo-router 58 makes an href: null tab unreachable (router.push('/coach') did nothing). */}
        <Tabs.Screen name="log" />
        <Tabs.Screen name="coach" />
        <Tabs.Screen name="community" />
      </Tabs>
      <PlusSheet visible={plus} onClose={() => setPlus(false)} />
    </>
  );
}
