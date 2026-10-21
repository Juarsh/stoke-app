// Habits screen (build-plan item 14; spec §10.1; habits-v2/hb1-habits-screen). Back, "+ Add habit"; "Tue 20 Oct · 1 of 4
// done". Rows: full name and "8 glasses · 5 days" (target and streak; a partial amount reads "5 of 8 glasses"); tapping
// the row ticks it at the full target (or un-ticks) with the habit toast; a divider and a separate 48dp › open detail.
// Not done first in the user's order, done at the end; done rows are solid sage. Habits not due today are listed under
// "Not today" (open detail only), so every habit can be reached. Drag reorder is cut (M2/M3 lean run).
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, Vibration, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { T } from '@/components/ui';
import { useHabits } from '@/lib/habits';
import { useLogDay } from '@/lib/useLogDay';
import { useStore } from '@/lib/store';
import { useTheme } from '@/theme';
import { dayLabel } from '../workout/history';
import { Header } from '../plans/parts';
import { active, daysCount, daysText, Habit, isDoneOn, isDue, listOrder, logOf, partialText, snapOf, streak, targetText } from './model';

export function HabitsScreen() {
  const t = useTheme(); const router = useRouter(); const hb = useHabits(); const st = useStore(); const today = useLogDay();
  if (!hb.ready) return null;
  const s = hb.state;
  const rows = listOrder(s, today);
  const off = active(s).filter((h) => !isDue(h, today));
  const doneN = rows.filter((h) => isDoneOn(s, h.id, today)).length;
  const open = (h: Habit) => router.push({ pathname: '/habit/[id]', params: { id: h.id } } as never);
  const sub = (h: Habit) => {
    const n = streak(s, h, today);
    const first = partialText(logOf(s, h.id, today)) ?? targetText(snapOf(h));
    return [first, n ? daysCount(n) : null].filter(Boolean).join(' · ');
  };
  const row = (h: Habit, tickable: boolean) => {
    const done = tickable && isDoneOn(s, h.id, today);
    const fg = done ? (t.dark ? '#15121B' : '#FFFFFF') : t.c.text;
    const line = tickable ? sub(h) : `${daysText(h)}${targetText(snapOf(h)) ? ` · ${targetText(snapOf(h))}` : ''}`;
    const tick = () => { const was = done; const e = hb.toggle(h.id, today, today); if (e) st.showNotice(e); else Vibration.vibrate(was ? 8 : 15); };
    return (
      <View key={h.id} style={{ flexDirection: 'row', alignItems: 'stretch', borderRadius: t.radius.card, backgroundColor: done ? t.c.train : t.c.card,
        borderWidth: done ? 0 : 1, borderColor: t.c.lineSoft, overflow: 'hidden', minHeight: 72 }}>
        <Pressable onPress={tickable ? tick : () => open(h)} accessibilityRole="button" testID={`row-${h.short_name}`}
          accessibilityLabel={tickable ? (done ? `${h.name}, done. Double-tap to undo` : `${h.name}${targetText(snapOf(h)) ? `, ${targetText(snapOf(h))}` : ''}, not done yet. Double-tap to mark done`) : `${h.name}, not today. Open ${h.name}`}
          style={({ pressed }) => ({ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 16, paddingLeft: 18, paddingVertical: 12, backgroundColor: pressed ? (done ? t.c.sageFill : t.c.card2) : 'transparent' })}>
          {tickable ? (
            <View style={{ width: 28, height: 28, borderRadius: 8, borderWidth: done ? 0 : 2, borderColor: t.c.stateLine, alignItems: 'center', justifyContent: 'center' }}>
              {done ? <T style={{ color: fg, fontSize: 18 }}>✓</T> : null}
            </View>
          ) : null}
          <View style={{ flex: 1, gap: 2 }}>
            <T v="bodyStrong" style={{ fontSize: 18, color: fg }}>{h.name}</T>
            {line ? <T style={{ fontSize: 14, color: done ? fg : t.c.text2 }}>{line}</T> : null}
          </View>
        </Pressable>
        <View style={{ width: 1, marginVertical: 14, backgroundColor: done ? 'rgba(255,255,255,0.4)' : t.c.lineSoft }} />
        <Pressable onPress={() => open(h)} accessibilityRole="button" accessibilityLabel={`Open ${h.name}`}
          style={{ width: 56, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="chev" color={fg} size={18} strokeWidth={2.4} />
        </Pressable>
      </View>
    );
  };
  return (
    <View style={{ flex: 1, backgroundColor: t.c.bg }} testID="habits-screen">
      <Header title="Habits" right={
        <Pressable onPress={() => router.push('/habit-form' as never)} accessibilityRole="button" accessibilityLabel="Add habit"
          style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Icon name="plus" color={t.c.accentText} size={18} strokeWidth={2.4} />
          <T v="bodyStrong" style={{ fontSize: 17, color: t.c.accentText }}>Add habit</T>
        </Pressable>} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 120, gap: 10 }}>
        <T tone="text2" style={{ fontSize: 15, marginBottom: 2, paddingHorizontal: 4 }}>{rows.length ? `${dayLabel(today)} · ${doneN} of ${rows.length} done` : dayLabel(today)}</T>
        {!rows.length && !off.length ? (
          <View style={{ backgroundColor: t.c.card, borderRadius: t.radius.card, padding: 20, gap: 6 }} testID="habits-empty">
            <T v="bodyStrong" style={{ fontSize: 17 }}>No habits yet</T>
            <T tone="text2" style={{ fontSize: 15 }}>Add one, like Water 8 glasses or Read 10 pages.</T>
          </View>
        ) : null}
        {rows.map((h) => row(h, true))}
        {off.length ? <T v="bodyStrong" accessibilityRole="header" style={{ fontSize: 15, marginTop: 10, paddingHorizontal: 4 }}>Not today</T> : null}
        {off.map((h) => row(h, false))}
      </ScrollView>
    </View>
  );
}
