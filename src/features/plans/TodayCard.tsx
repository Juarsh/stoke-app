// Today's workout ink card (build-plan item 9; full-b2 home / train, home-empty "No plan yet", states #8 rest day) and,
// while a workout is in progress, the resume banner (states #7: Resume / Discard). Reads the active plan for the 4 AM log
// day it is given (dayOf via useLogDay on Home / Train). Start workout / Empty workout open the logger (item 10).
import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { T } from '@/components/ui';
import { exercises, type ExerciseRepo } from '@/lib/exercises';
import { usePlans } from '@/lib/plans';
import { useWorkouts } from '@/lib/workouts';
import { clock, minutes, stats } from '../workout/model';
import { Confirm } from './parts';
import { useState } from 'react';
import { useTheme } from '@/theme';
import { countLabel, estMinutes, namesLine, nextLine, todayWorkout } from './model';

export function TodayCard({ date, names = 2, repo = exercises }: { date: string; names?: number; repo?: ExerciseRepo }) {
  const t = useTheme(); const router = useRouter(); const plans = usePlans(); const w = useWorkouts();
  const [discard, setDiscard] = useState(false);
  if (!plans.ready || !w.ready) return null;
  const today = todayWorkout(plans.state, date);
  const open = () => router.push('/workout' as never);
  const empty = () => { w.startEmpty(); open(); };
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
  const a = w.active;
  if (a) {
    const s = stats(a, repo);
    return (
      <View style={card} testID="today-card-active">
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', columnGap: 8 }}>
          {eyebrow('Workout in progress')}<T style={{ color: t.c.inkMuted, fontSize: 13 }}>{`Started ${clock(a.started_at)}`}</T>
        </View>
        <T v="display" accessibilityRole="header" style={{ color: t.c.inkText, fontSize: 26, lineHeight: 32 }}>{`${a.title} in progress · ${minutes(a.started_at, Date.now())} min`}</T>
        <T style={{ color: t.c.inkMuted, fontSize: 14 }}>{`${s.done} of ${s.total} sets are saved.`}</T>
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
          <Pressable onPress={open} accessibilityRole="button" accessibilityLabel="Resume workout"
            style={({ pressed }) => ({ flex: 1, minHeight: 52, borderRadius: 16, backgroundColor: t.c.accentFill, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: pressed ? 0.85 : 1 })}>
            <Icon name="play" color={t.c.onAccent} size={14} /><T v="button" style={{ color: t.c.onAccent, fontSize: 17 }}>Resume</T>
          </Pressable>
          <Pressable onPress={() => setDiscard(true)} accessibilityRole="button" accessibilityLabel="Discard workout"
            style={({ pressed }) => ({ flex: 1, minHeight: 52, borderRadius: 16, borderWidth: 1.5, borderColor: t.c.inkMuted, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.85 : 1 })}>
            <T v="button" style={{ color: t.c.inkText, fontSize: 17 }}>Discard</T>
          </Pressable>
        </View>
        <Confirm visible={discard} title="Discard workout?" body={s.done ? `${s.done} ticked ${s.done === 1 ? 'set' : 'sets'} will not be saved.` : 'No sets are ticked, so there is nothing to save.'}
          keep="Keep going" drop="Discard workout" onKeep={() => setDiscard(false)} onDrop={() => { setDiscard(false); w.discard(); }} />
      </View>
    );
  }
  if (today.kind === 'none') {
    return (
      <View style={card} testID="today-card-none">
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', columnGap: 8 }}>
          {eyebrow('Training')}<T style={{ color: t.c.inkMuted, fontSize: 13 }}>Setup · about 2 min</T>
        </View>
        <T v="display" accessibilityRole="header" style={{ color: t.c.inkText, fontSize: 32, lineHeight: 38 }}>No plan yet</T>
        <T style={{ color: t.c.inkMuted, fontSize: 14, lineHeight: 20 }}>Pick a split like Push · Pull · Legs. You can change it later.</T>
        {honey('Choose a plan', () => router.push('/choose-plan' as never))}
        {link('or start an empty workout', empty)}
      </View>
    );
  }
  if (today.kind === 'rest') {
    return (
      <View style={card} testID="today-card-rest">
        {eyebrow('Today')}
        <T v="display" accessibilityRole="header" style={{ color: t.c.inkText, fontSize: 32, lineHeight: 38 }}>Rest day</T>
        <T style={{ color: t.c.inkMuted, fontSize: 14, lineHeight: 20 }}>{nextLine(today.next)}</T>
        {link('Start a workout anyway', empty)}
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
      {honey('Start workout', () => { w.start(r, today.plan.id); open(); }, true)}
    </View>
  );
}
