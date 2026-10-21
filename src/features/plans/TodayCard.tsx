// Today's workout ink card (build-plan item 9; full-b2 home / train, home-empty "No plan yet", states #8 rest day).
// Reads the active plan for the 4 AM log day it is given (dayOf via useLogDay on Home / Train). "Last time" and the logger
// itself come with items 10–12: until then Start workout says so instead of opening anything.
import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { T } from '@/components/ui';
import { exercises, type ExerciseRepo } from '@/lib/exercises';
import { usePlans } from '@/lib/plans';
import { useStore } from '@/lib/store';
import { useTheme } from '@/theme';
import { countLabel, estMinutes, namesLine, nextLine, todayWorkout } from './model';

export const LOGGER_SOON = 'Logging a workout comes in the next build. Your plan is saved.';

export function TodayCard({ date, names = 2, repo = exercises }: { date: string; names?: number; repo?: ExerciseRepo }) {
  const t = useTheme(); const router = useRouter(); const plans = usePlans(); const st = useStore();
  if (!plans.ready) return null;
  const today = todayWorkout(plans.state, date);
  const soon = () => st.showNotice(LOGGER_SOON);
  const card = { backgroundColor: t.c.ink, borderRadius: t.radius.card, padding: 20, gap: 6 } as const;
  const eyebrow = (s: string) => <T v="eyebrow" style={{ color: t.c.inkText, fontSize: 13, letterSpacing: 1 }}>{s}</T>;
  const honey = (title: string, onPress: () => void, play?: boolean) => (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={title}
      style={({ pressed }) => ({ marginTop: 12, minHeight: 56, borderRadius: 16, backgroundColor: t.c.accentFill, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, opacity: pressed ? 0.85 : 1 })}>
      {play ? <Icon name="play" color={t.c.onAccent} size={14} /> : null}
      <T v="button" style={{ color: t.c.onAccent, fontSize: 17 }}>{title}</T>
    </Pressable>
  );
  const link = (title: string, onPress: () => void) => (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={title} style={{ minHeight: 48, alignItems: 'center', justifyContent: 'center', marginBottom: -10 }}>
      <T v="bodyStrong" style={{ color: t.c.accentFill, fontSize: 15 }}>{title}</T>
    </Pressable>
  );
  if (today.kind === 'none') {
    return (
      <View style={card} testID="today-card-none">
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', columnGap: 8 }}>
          {eyebrow('Training')}<T style={{ color: t.c.inkMuted, fontSize: 13 }}>Setup · about 2 min</T>
        </View>
        <T v="display" accessibilityRole="header" style={{ color: t.c.inkText, fontSize: 32, lineHeight: 38 }}>No plan yet</T>
        <T style={{ color: t.c.inkMuted, fontSize: 14, lineHeight: 20 }}>Pick a split like Push · Pull · Legs. You can change it later.</T>
        {honey('Choose a plan', () => router.push('/train/choose-plan' as never))}
        {link('or start an empty workout', soon)}
      </View>
    );
  }
  if (today.kind === 'rest') {
    return (
      <View style={card} testID="today-card-rest">
        {eyebrow('Today')}
        <T v="display" accessibilityRole="header" style={{ color: t.c.inkText, fontSize: 32, lineHeight: 38 }}>Rest day</T>
        <T style={{ color: t.c.inkMuted, fontSize: 14, lineHeight: 20 }}>{nextLine(today.next)}</T>
        {link('Start a workout anyway', soon)}
      </View>
    );
  }
  const r = today.routine;
  const meta = `${countLabel(r.exercises.length)} · ~${estMinutes(r)} min`;
  return (
    <View style={card} testID="today-card-routine">
      {eyebrow('Today’s workout')}
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', columnGap: 12 }}>
        <T v="display" accessibilityRole="header" style={{ color: t.c.inkText, fontSize: 32, lineHeight: 40, flexShrink: 1 }}>{r.name}</T>
        <T style={{ color: t.c.inkMuted, fontSize: 15 }}>{meta}</T>
      </View>
      <T style={{ color: t.c.inkMuted, fontSize: 14 }}>{namesLine(r, repo, names)}</T>
      {honey('Start workout', soon, true)}
    </View>
  );
}
