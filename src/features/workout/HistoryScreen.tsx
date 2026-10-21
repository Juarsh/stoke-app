// Workout history (build-plan item 12; full-b2 train-history): "Workout history · 33 since 24 Aug", All + title chips,
// "This week" then "12–18 Oct · 5 workouts"; each card: title + day, volume, "62 min · 6 exercises · 20 sets · 207 reps",
// "Top set: Bench Press 80 kg × 6"; tap opens the session. PR badges are cut from v1 (CEO).
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { T } from '@/components/ui';
import { exercises, ExerciseRepo } from '@/lib/exercises';
import { useLogDay } from '@/lib/useLogDay';
import { useWorkouts } from '@/lib/workouts';
import { useTheme } from '@/theme';
import { Header } from '../plans/parts';
import { dayLabel, durationMin, fmtVolume, historyGroups, sinceLine, titleChips, topSet } from './history';
import { stats } from './model';

const n = (x: number) => Math.round(x).toLocaleString('en-US');

export function HistoryScreen({ repo = exercises }: { repo?: ExerciseRepo }) {
  const t = useTheme(); const router = useRouter(); const w = useWorkouts(); const today = useLogDay();
  const [chip, setChip] = useState<string | null>(null);
  if (!w.ready) return null;
  const all = w.state.sessions; const chips = titleChips(all);
  const shown = chip ? all.filter((s) => s.title === chip) : all;
  const since = sinceLine(all);
  return (
    <View style={{ flex: 1, backgroundColor: t.c.bg }} testID="workout-history">
      <Header title="Workout history" right={since ? <T tone="text2" style={{ fontSize: 14 }}>{since}</T> : undefined} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: t.sizes.nav + 24 }}>
        {chips.length ? (
          <View style={{ flexDirection: 'row', backgroundColor: t.c.card2, borderRadius: 16, padding: 4, gap: 4 }} accessibilityRole="tablist">
            {[null, ...chips].map((c) => {
              const on = chip === c;
              return (
                <Pressable key={c ?? 'all'} onPress={() => setChip(c)} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={c ?? 'All'}
                  style={{ flex: 1, minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? t.c.card : 'transparent', paddingHorizontal: 4 }}>
                  <T v={on ? 'bodyStrong' : 'body'} numberOfLines={1} style={{ fontSize: 15 }}>{c ?? 'All'}</T>
                </Pressable>
              );
            })}
          </View>
        ) : null}
        {!all.length ? (
          <View style={{ backgroundColor: t.c.card, borderRadius: t.radius.card, padding: 20, gap: 6 }} testID="history-empty">
            <T v="bodyStrong" style={{ fontSize: 17 }}>No workouts yet</T>
            <T tone="text2" style={{ fontSize: 15 }}>Finished workouts show up here.</T>
          </View>
        ) : null}
        {historyGroups(shown, today).map((g, gi) => (
          <View key={g.key} style={{ gap: 10 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: gi ? 6 : 0 }}>
              <T v="bodyStrong" accessibilityRole="header" style={{ fontSize: 15 }}>{g.title}</T>
              {gi === 0 ? <T tone="text2" style={{ fontSize: 14 }}>Volume</T> : null}
            </View>
            {g.sessions.map((s) => {
              const st = stats(s, repo); const top = topSet(s, repo);
              const meta = `${durationMin(s)} min · ${n(st.exercises)} exercise${st.exercises === 1 ? '' : 's'} · ${n(st.done)} set${st.done === 1 ? '' : 's'} · ${n(st.reps)} reps`;
              return (
                <Pressable key={s.id} onPress={() => router.push({ pathname: '/train/session/[id]', params: { id: s.id } } as never)} accessibilityRole="button"
                  accessibilityLabel={`${s.title}, ${dayLabel(s.local_date)}, ${fmtVolume(st.volume)}. ${meta}.${top ? ` Top set: ${top}.` : ''} Open`}
                  style={({ pressed }) => ({ backgroundColor: t.c.card, borderRadius: t.radius.card, borderWidth: 1, borderColor: t.c.lineSoft, padding: 16, gap: 4, opacity: pressed ? 0.85 : 1 })}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <T style={{ flex: 1, fontSize: 14 }} numberOfLines={1}><T v="bodyStrong" style={{ fontSize: 18 }}>{s.title}</T>{`  ${dayLabel(s.local_date)}`}</T>
                    <T v="bodyStrong" style={{ fontSize: 17 }}>{fmtVolume(st.volume)}</T>
                    <Icon name="chev" color={t.c.text2} size={18} strokeWidth={2.2} />
                  </View>
                  <T tone="text2" style={{ fontSize: 14 }}>{meta}</T>
                  {top ? <T style={{ fontSize: 15 }}>{`Top set: ${top}`}</T> : null}
                </Pressable>
              );
            })}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
