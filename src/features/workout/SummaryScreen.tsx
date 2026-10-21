// Workout summary (build-plan item 12; full-b2 workout-summary): opens right after Finish. "Workout done" (✕), the ink stats
// card, one row per exercise "3 sets · best 120 kg × 5", the protein nudge (Log food › / Ask Coach ›) and "Workouts don't
// change your calorie goal." Done returns to where the workout was started. PR badges are cut from v1 (CEO).
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { T } from '@/components/ui';
import { exercises, ExerciseRepo } from '@/lib/exercises';
import { useDay } from '@/lib/useDay';
import { useLogDay } from '@/lib/useLogDay';
import { useWorkouts } from '@/lib/workouts';
import { useTheme } from '@/theme';
import { foodCard } from '../home/model';
import { Box, Header } from '../plans/parts';
import { bestLine, proteinNudge } from './history';
import { kindOf } from './model';
import { InkStats } from './SessionParts';

export const CALORIE_NOTE = 'Workouts don’t change your calorie goal.';

export function SummaryScreen({ id, repo = exercises }: { id: string; repo?: ExerciseRepo }) {
  const t = useTheme(); const router = useRouter(); const ins = useSafeAreaInsets(); const w = useWorkouts();
  const today = useLogDay(); const d = useDay(today);
  const s = w.state.sessions.find((x) => x.id === id);
  const close = () => (router.canGoBack() ? router.back() : router.replace('/(tabs)/train' as never));
  if (!w.ready) return null;
  if (!s) {
    return (
      <View style={{ flex: 1, backgroundColor: t.c.bg }}>
        <Header title="Workout done" close onClose={close} />
        <T tone="text2" style={{ padding: 20, fontSize: 15 }}>This workout isn’t on this phone any more.</T>
      </View>
    );
  }
  const food = foodCard(d.entries, d.kcalTarget, d.proteinTarget);
  const link = (title: string, to: string) => (
    <Pressable onPress={() => router.push(to as never)} accessibilityRole="button" accessibilityLabel={title} style={{ minHeight: 48, justifyContent: 'center' }}>
      <T v="bodyStrong" style={{ color: t.c.accentText, fontSize: 15 }}>{`${title} ›`}</T>
    </Pressable>
  );
  return (
    <View style={{ flex: 1, backgroundColor: t.c.bg }} testID="workout-summary">
      <Header title="Workout done" close onClose={close} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 24 }}>
        <InkStats s={s} repo={repo} eyebrow="title" />
        <Box>
          {s.exercises.map((x, i) => {
            const e = repo.byId(x.exercise_id); const line = bestLine(x, kindOf(e));
            return (
              <View key={x.id} accessible accessibilityLabel={`${e?.name ?? 'Exercise'}: ${line}`}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingHorizontal: 18, paddingVertical: 8, borderTopWidth: i ? 1 : 0, borderTopColor: t.c.lineSoft, flexWrap: 'wrap' }}>
                <T v="bodyStrong" style={{ fontSize: 16, flex: 1, minWidth: 120 }}>{e?.name ?? 'Exercise'}</T>
                <T tone="text2" style={{ fontSize: 14 }}>{line}</T>
              </View>
            );
          })}
        </Box>
        <View style={{ backgroundColor: t.c.accentTint, borderRadius: t.radius.card, padding: 16, flexDirection: 'row', gap: 12 }} testID="protein-nudge">
          <View style={{ paddingTop: 2 }}><Icon name="spark" color={t.c.accentText} size={18} /></View>
          <View style={{ flex: 1 }}>
            <T style={{ fontSize: 15, lineHeight: 21 }}>{proteinNudge(food.protein, food.proteinTarget)}</T>
            <View style={{ flexDirection: 'row', gap: 20 }}>{link('Log food', '/log-food')}{link('Ask Coach', '/coach')}</View>
          </View>
        </View>
        <T tone="text2" style={{ fontSize: 14 }}>{CALORIE_NOTE}</T>
      </ScrollView>
      <View style={{ padding: 16, paddingBottom: 16 + ins.bottom, borderTopWidth: 1, borderTopColor: t.c.lineSoft, backgroundColor: t.c.bg }}>
        <Pressable onPress={close} accessibilityRole="button" accessibilityLabel="Done"
          style={({ pressed }) => ({ minHeight: 56, borderRadius: 16, backgroundColor: t.c.accentFill, borderWidth: 1.5, borderColor: t.c.honeyEdge, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.85 : 1 })}>
          <T v="button" style={{ color: t.c.onAccent, fontSize: 17 }}>Done</T>
        </Pressable>
      </View>
    </View>
  );
}
