// Train tab (build-plan item 9 on top of item 8; full-b2 train): Today's workout ink card, This week's split (Edit), Plans
// (+ New plan, ACTIVE tag), then Exercises. Done ticks, "Last 14 Oct", History and the "4 in last 7 days" chip need logged
// workouts and come with items 10–12; the split shows what is planned only.
import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { Screen, T } from '@/components/ui';
import { usePlans } from '@/lib/plans';
import { useLogDay } from '@/lib/useLogDay';
import { useTheme } from '@/theme';
import { activePlan, daysCount, splitRows } from './model';
import { Box, TextLink } from './parts';
import { TodayCard } from './TodayCard';
import { useWorkouts } from '@/lib/workouts';

export function TrainScreen() {
  const t = useTheme(); const router = useRouter(); const plans = usePlans(); const w = useWorkouts(); const date = useLogDay();
  const plan = activePlan(plans.state);
  const go = (path: string, params?: Record<string, string>) => router.push((params ? { pathname: path, params } : path) as never);
  const divider = { borderTopWidth: 1, borderTopColor: t.c.lineSoft } as const;
  return (
    <Screen title="Train">
      <View style={{ gap: 12, paddingBottom: t.sizes.nav + 24 }}>
        <TodayCard date={date} names={3} />
        {plan ? (
          <Box testID="split-card">
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 18, paddingRight: 12, flexWrap: 'wrap' }}>
              <T v="bodyStrong" accessibilityRole="header" style={{ fontSize: 16, flex: 1, minWidth: 140 }}>This week’s split</T>
              <TextLink title="Empty workout" onPress={() => { w.startEmpty(); go('/workout'); }} a11y="Start an empty workout" />
              <TextLink title="Edit" onPress={() => go('/plan/[id]', { id: plan.id })} a11y={`Edit ${plan.name}`} />
            </View>
            {splitRows(plan, date).map((row) => {
              const r = row.routine;
              const label = `${row.label}${row.today ? ', today' : ''}: ${r ? r.name : 'Rest'}`;
              const body = (
                <>
                  <T v="bodyStrong" tone={r ? 'text2' : 'muted'} style={{ width: 44, fontSize: 14 }}>{row.label}</T>
                  {r ? <View style={{ width: 26, height: 26, borderRadius: 13, borderWidth: 2, borderColor: row.today ? t.c.train : t.c.stateLine }} />
                    : <View style={{ width: 26, alignItems: 'center' }}><Icon name="moon" color={t.c.muted} size={16} /></View>}
                  <T v={r ? 'bodyStrong' : 'body'} tone={r ? 'text' : 'muted'} style={{ flex: 1, fontSize: r ? 17 : 15 }}>{r ? r.name : 'Rest'}</T>
                  {row.today && r ? <T tone="muted" style={{ fontSize: 14 }}>Today</T> : null}
                  {r ? <Icon name="chev" color={t.c.text2} size={18} strokeWidth={2.2} /> : null}
                </>
              );
              const style = { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: r ? 56 : 48, paddingHorizontal: 18, ...divider } as const;
              return r ? (
                <Pressable key={row.weekday} onPress={() => go('/routine/[id]', { id: r.id, plan: plan.id })} accessibilityRole="button" accessibilityLabel={`${label}. Edit routine`}
                  style={({ pressed }) => [style, { opacity: pressed ? 0.85 : 1 }]}>{body}</Pressable>
              ) : <View key={row.weekday} style={style} accessible accessibilityLabel={label}>{body}</View>;
            })}
          </Box>
        ) : null}
        {plans.state.plans.length ? (
          <Box testID="plans-card">
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 18, paddingRight: 12 }}>
              <T v="bodyStrong" accessibilityRole="header" style={{ fontSize: 16, flex: 1 }}>Plans</T>
              <TextLink title="+ New plan" onPress={() => go('/choose-plan')} a11y="New plan" />
            </View>
            {plans.state.plans.map((p) => {
              const on = p.id === plans.state.activeId;
              return (
                <Pressable key={p.id} onPress={() => go('/plan/[id]', { id: p.id })} accessibilityRole="button" accessibilityLabel={`${p.name}, ${daysCount(p)}${on ? ', active' : ''}. Open`}
                  style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 56, paddingHorizontal: 18, ...divider, opacity: pressed ? 0.85 : 1 })}>
                  <T style={{ flex: 1, fontSize: 16 }}><T v="bodyStrong" style={{ fontSize: 16 }}>{p.name}</T><T tone="muted" style={{ fontSize: 14 }}> · {daysCount(p)}</T></T>
                  {on ? <View style={{ backgroundColor: t.c.accentTint, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 }}><T v="eyebrow" style={{ color: t.c.accentText, fontSize: 12 }}>Active</T></View> : null}
                  <Icon name="chev" color={t.c.text2} size={18} strokeWidth={2.2} />
                </Pressable>
              );
            })}
          </Box>
        ) : null}
        <Box>
          <T v="bodyStrong" accessibilityRole="header" style={{ fontSize: 16, paddingHorizontal: 18, paddingTop: 16, paddingBottom: 4 }}>Exercises</T>
          <Pressable onPress={() => go('/train/exercises')} accessibilityRole="button" accessibilityLabel="Browse exercises, how-tos"
            style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 18, opacity: pressed ? 0.85 : 1 })}>
            <Icon name="search" color={t.c.text} size={18} strokeWidth={2} />
            <T style={{ flex: 1, fontSize: 16 }}><T v="bodyStrong" style={{ fontSize: 16 }}>Browse exercises</T><T tone="muted" style={{ fontSize: 14 }}> · how-tos</T></T>
            <Icon name="chevron" color={t.c.text2} size={18} strokeWidth={2.2} />
          </Pressable>
        </Box>
      </View>
    </Screen>
  );
}
