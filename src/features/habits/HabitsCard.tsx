// Home habits B2 (build-plan item 13; spec §7; rework/habits-B2 frames). "Habits ›" (opens Habits) and "+ Add" (Create
// habit), no counter. One row: 3 × 74dp habit slots + a 56dp More slot ("+N", opens Habits), 4dp gaps. Undone first in
// the user's order, then the most recently done; fewer than 3 share the row; none → "+ Add habit"; all done → "All N done".
// One tap ticks the full target (or un-ticks); the row holds still while a toast is up and settles 4 s after the last one
// closes (Q7), so nothing moves under a finger. Each item has a Details action (and long-press) that opens the habit.
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, useWindowDimensions, Vibration, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { T } from '@/components/ui';
import { useHabits } from '@/lib/habits';
import { useStore } from '@/lib/store';
import { useTheme } from '@/theme';
import { HabitItem } from './HabitIcon';
import { dueToday, homeA11y, homeOrder, homeRow, isDoneOn } from './model';

export function HabitsCard({ date }: { date: string }) {
  const t = useTheme(); const router = useRouter(); const hb = useHabits(); const st = useStore();
  const { fontScale } = useWindowDimensions();
  const large = fontScale > 1.15;
  const s = hb.state;
  const membership = dueToday(s, date).map((h) => h.id).sort().join(',');
  const [order, setOrder] = useState<string[]>(() => homeOrder(s, date));
  const live = useRef(s); live.current = s;
  // settle: after the 4 s hold (settleGen), on a new day, on load, or when habits are added / archived — never on a tick
  useEffect(() => { setOrder(homeOrder(live.current, date)); }, [hb.settleGen, date, membership, hb.ready]);
  if (!hb.ready) return null;
  const row = homeRow(s, date, order);
  const tick = (id: string) => {
    const was = isDoneOn(s, id, date);
    const err = hb.toggle(id, date, date);
    if (err) { st.showNotice(err); return; }
    Vibration.vibrate(was ? 8 : 15);
  };
  const open = (id: string) => router.push({ pathname: '/habit/[id]', params: { id } } as never);
  const header = (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <Pressable onPress={() => router.push('/habits' as never)} accessibilityRole="button" accessibilityLabel="Habits, open Habits"
        style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 4, paddingRight: 8 }}>
        <T v="bodyStrong" accessibilityRole="header" style={{ fontSize: 17 }}>Habits</T>
        <Icon name="chev" color={t.c.text} size={16} strokeWidth={2.4} />
      </Pressable>
      {row.kind !== 'none' ? (
        <Pressable onPress={() => router.push('/habit-form' as never)} accessibilityRole="button" accessibilityLabel="Add habit"
          style={{ minHeight: 48, minWidth: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
          <Icon name="plus" color={t.c.accentText} size={18} strokeWidth={2.4} />
          <T v="bodyStrong" style={{ fontSize: 17, color: t.c.accentText }}>Add</T>
        </Pressable>
      ) : null}
    </View>
  );
  const card = { backgroundColor: t.c.card, borderRadius: t.radius.card, borderWidth: 1, borderColor: t.c.lineSoft, paddingHorizontal: 20, paddingTop: 6, paddingBottom: 12 } as const;
  if (row.kind === 'none') {
    return (
      <View style={card} testID="habits-card-empty">
        {header}
        <Pressable onPress={() => router.push('/habit-form' as never)} accessibilityRole="button" accessibilityLabel="Add habit"
          style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Icon name="plus" color={t.c.accentText} size={18} strokeWidth={2.4} />
          <T v="bodyStrong" style={{ fontSize: 16, color: t.c.accentText }}>Add habit</T>
        </Pressable>
      </View>
    );
  }
  if (row.kind === 'all-done') {
    return (
      <View style={card} testID="habits-card-alldone">
        {header}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 36 }} accessible accessibilityLabel={`All ${row.total} habits done`}>
          <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: t.c.train, alignItems: 'center', justifyContent: 'center' }}>
            <T style={{ color: t.dark ? '#15121B' : '#FFFFFF', fontSize: 13 }}>✓</T>
          </View>
          <T v="bodyStrong" style={{ fontSize: 16 }}>{`All ${row.total} done`}</T>
        </View>
      </View>
    );
  }
  const slots = row.ids.map((id) => s.habits.find((h) => h.id === id)!).filter(Boolean);
  return (
    <View style={card} testID="habits-card">
      {header}
      <View style={{ flexDirection: 'row', justifyContent: slots.length === 3 ? 'space-between' : 'flex-start', gap: 4, marginTop: 2 }}>
        {slots.map((h) => {
          const done = isDoneOn(s, h.id, date);
          return (
            <Pressable key={h.id} testID={`habit-${h.short_name}`} onPress={() => tick(h.id)} onLongPress={() => open(h.id)} delayLongPress={450}
              accessibilityRole="button" accessibilityLabel={homeA11y(h, done)} accessibilityState={{ checked: done }}
              accessibilityActions={[{ name: 'activate' }, { name: 'details', label: 'Details' }]}
              onAccessibilityAction={(e) => (e.nativeEvent.actionName === 'details' ? open(h.id) : tick(h.id))}
              style={({ pressed }) => ({ width: 74, minHeight: 64, alignItems: 'center', paddingTop: 6, paddingBottom: 4, borderRadius: 14, backgroundColor: pressed ? t.c.card2 : 'transparent' })}>
              <HabitItem short={h.short_name} name={h.name} icon={h.icon} done={done} twoLines={large} />
            </Pressable>
          );
        })}
        {row.more ? (
          <Pressable onPress={() => router.push('/habits' as never)} accessibilityRole="button" accessibilityLabel={`${row.more} more habit${row.more === 1 ? '' : 's'}, open Habits`}
            style={({ pressed }) => ({ width: 56, minHeight: 64, alignItems: 'center', paddingTop: 6, gap: 6, borderRadius: 14, backgroundColor: pressed ? t.c.card2 : 'transparent' })}>
            <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: t.c.card2, alignItems: 'center', justifyContent: 'center' }}>
              <T v="bodyStrong" style={{ fontSize: 14, color: t.c.text2 }}>{`+${row.more}`}</T>
            </View>
            <T v="bodyStrong" style={{ fontSize: 15, color: t.c.text, fontWeight: '700' }}>More</T>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
