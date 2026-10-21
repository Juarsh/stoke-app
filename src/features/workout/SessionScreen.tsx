// Session detail (build-plan item 12; full-b2 session-detail): title, ⋯ (Delete workout, with a confirm), the ink stats card,
// "N exercises · kg × reps", one row per exercise "80×6 · 80×6 · 77.5×7" with its volume and set count. Exercise trends and
// PRs are cut from v1 (CEO), so rows don't open anything.
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { T } from '@/components/ui';
import { exercises, ExerciseRepo } from '@/lib/exercises';
import { useWorkouts } from '@/lib/workouts';
import { useTheme } from '@/theme';
import { Box, Confirm, Header } from '../plans/parts';
import { exVolume, fmtVolume, setsCount, setsLine } from './history';
import { kindOf } from './model';
import { InkStats } from './SessionParts';

export function SessionScreen({ id, repo = exercises }: { id: string; repo?: ExerciseRepo }) {
  const t = useTheme(); const router = useRouter(); const w = useWorkouts();
  const [ask, setAsk] = useState(false);
  if (!w.ready) return null;
  const s = w.state.sessions.find((x) => x.id === id);
  if (!s) {
    return (
      <View style={{ flex: 1, backgroundColor: t.c.bg }}>
        <Header title="Workout" />
        <T tone="text2" style={{ padding: 20, fontSize: 15 }}>This workout isn’t on this phone any more.</T>
      </View>
    );
  }
  const k = s.exercises.length;
  return (
    <View style={{ flex: 1, backgroundColor: t.c.bg }} testID="session-detail">
      <Header title={s.title} right={
        <Pressable onPress={() => setAsk(true)} accessibilityRole="button" accessibilityLabel="Delete workout" style={{ minHeight: 48, paddingHorizontal: 6, justifyContent: 'center' }}>
          <T v="bodyStrong" style={{ color: t.c.accentText, fontSize: 15 }}>Delete</T>
        </Pressable>} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: t.sizes.nav + 24 }}>
        <InkStats s={s} repo={repo} eyebrow="date" />
        <Box>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 18, paddingVertical: 12 }}>
            <T v="bodyStrong" style={{ fontSize: 15 }}>{`${k} exercise${k === 1 ? '' : 's'}`}</T>
            <T tone="text2" style={{ fontSize: 14 }}>kg × reps</T>
          </View>
          {s.exercises.map((x) => {
            const e = repo.byId(x.exercise_id); const kind = kindOf(e); const line = setsLine(x, kind);
            const vol = kind === 'weight' || (kind === 'bodyweight' && exVolume(x, kind) > 0) ? fmtVolume(exVolume(x, kind)) : null;
            const cnt = setsCount(x.sets.filter((y) => y.done).length);
            return (
              <View key={x.id} accessible accessibilityLabel={`${e?.name ?? 'Exercise'}: ${line}. ${vol ? `${vol}, ` : ''}${cnt}`}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18, paddingVertical: 12, borderTopWidth: 1, borderTopColor: t.c.lineSoft }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <T v="bodyStrong" style={{ fontSize: 16 }}>{e?.name ?? 'Exercise'}</T>
                  <T tone="text2" style={{ fontSize: 14 }}>{line}</T>
                </View>
                <View style={{ alignItems: 'flex-end', gap: 2 }}>
                  {vol ? <T v="bodyStrong" style={{ fontSize: 16 }}>{vol}</T> : null}
                  <T tone="text2" style={{ fontSize: 14 }}>{cnt}</T>
                </View>
              </View>
            );
          })}
        </Box>
      </ScrollView>
      <Confirm visible={ask} title="Delete workout?" body={`${s.title} on this phone goes away. This can’t be undone.`} keep="Keep" drop="Delete workout"
        onDrop={() => { setAsk(false); w.deleteSession(s.id); router.back(); }} onKeep={() => setAsk(false)} />
    </View>
  );
}
