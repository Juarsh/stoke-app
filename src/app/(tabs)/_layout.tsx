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
        <Tabs.Screen name="log" options={{ href: null }} />
        <Tabs.Screen name="coach" options={{ href: null }} />
        <Tabs.Screen name="community" options={{ href: null }} />
      </Tabs>
      <PlusSheet visible={plus} onClose={() => setPlus(false)} />
    </>
  );
}
