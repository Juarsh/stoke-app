import { useRouter } from 'expo-router';
import { memo, useCallback, useEffect, useMemo } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CoachCard } from '@/components/CoachCard';
import { Ring } from '@/components/Ring';
import { Badge, Card, Row, T } from '@/components/ui';
import { flags } from '@/lib/config';
import type { FoodEntry, Slot } from '@/lib/domain';
import { localDate } from '@/lib/domain';
import { readTodaySteps } from '@/lib/health';
import { SLOT_LABEL, SLOTS } from '@/lib/labels';
import { useStore } from '@/lib/store';
import { useDay } from '@/lib/useDay';
import { makeStyles, useTheme } from '@/theme';

type Row = { slot: Slot; kcal: number; items: FoodEntry[] };
const MealRow = memo(function MealRow({ row }: { row: Row }) {
  return (
    <Card>
      <Row style={{ justifyContent: 'space-between' }}><T v="bodyStrong">{SLOT_LABEL[row.slot]}</T><T v="caption" tone="muted">{row.kcal} kcal</T></Row>
      {row.items.map((e) => (
        <Row key={e.id} style={{ justifyContent: 'space-between' }}>
          <T tone="text2" style={{ flex: 1 }}>{e.custom_name || e.dish_id?.replaceAll('_', ' ')} · {e.qty} {e.unit}</T>
          <T>{e.kcal.best}</T>
        </Row>
      ))}
    </Card>
  );
}, (a, b) => a.row === b.row);

export default function Today() {
  const t = useTheme(); const s = useStyles(); const st = useStore(); const d = useDay(); const router = useRouter();
  const { setSteps } = st;
  useEffect(() => { readTodaySteps().then((n) => { if (n !== null) { setSteps(localDate(), n); st.api.putSteps(localDate(), n).catch(() => {}); } }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo<Row[]>(() => SLOTS.map((slot) => {
    const items = d.entries.filter((e) => e.slot === slot);
    return { slot, items, kcal: items.reduce((a, e) => a + e.kcal.best, 0) };
  }).filter((r) => r.items.length), [d.entries]);
  const over = d.kcalLeft < 0;
  const header = useMemo(() => (
    <View style={{ gap: t.space.gap }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <T v="title">Today</T>
        <Row>
          <Badge kind="accent" label={`🔥 ${d.streak.current}`} />
          <Pressable onPress={() => router.push('/settings')} accessibilityLabel="Open settings" style={s.avatar} hitSlop={8}>
            <T v="bodyStrong" tone="primaryText">{(st.user?.name ?? '?').slice(0, 1).toUpperCase()}</T>
          </Pressable>
        </Row>
      </Row>
      {d.streak.freezeJustUsed ? (
        <Card tone="infoSoft"><T tone="infoText">❄ Your freeze saved your {d.streak.current}-day streak (used automatically, 1 per week).</T></Card>
      ) : d.streak.current === 0 && d.loggedDates.size > 0 ? (
        <Card tone="infoSoft"><T tone="infoText">Streak paused. Start again today.</T></Card>
      ) : null}
      <Card tone="glass">
        <View style={s.big}>
          <T v="display" tone={over ? 'over' : 'text'} accessibilityLabel={over ? `${-d.kcalLeft} calories over` : `${d.kcalLeft} calories left`}>{over ? `${-d.kcalLeft} kcal over` : d.kcalLeft}</T>
          {!over ? <T v="caption" tone="muted">calories left</T> : null}
        </View>
        <View style={s.rings}>
          <Ring value={d.tot.kcal} max={d.kcalTarget} from={t.c.primary2} to={t.c.primary} big={`${Math.max(0, d.kcalLeft)}`} caption="kcal left" a11y={`${d.tot.kcal} of ${d.kcalTarget} calories eaten`} />
          <Ring value={d.tot.protein} max={d.proteinTarget} from={t.c.accent2} to={t.c.accent} big={`${Math.round(d.proteinLeft)} g`} caption="protein left" a11y={`${d.tot.protein} of ${d.proteinTarget} grams protein`} />
          {flags.steps ? <Ring value={d.steps} max={d.profile?.stepsTarget ?? 8000} from={t.c.steps2} to={t.c.steps} big={d.steps.toLocaleString('en-IN')} caption="steps" a11y={`${d.steps} steps`} /> : null}
        </View>
        {flags.steps ? <T v="caption" tone="muted">Steps burned ≈ {d.burn} kcal · {d.profile?.addStepKcal ? 'added to' : 'not added to'} food budget</T> : null}
      </Card>
      <CoachCard kcalLeft={d.kcalLeft} proteinLeft={d.proteinLeft} picks={d.picks} />
    </View>
  ), [d, t, s, st.user?.name, over, router]);
  const renderItem = useCallback(({ item }: { item: Row }) => <MealRow row={item} />, []);
  return (
    <SafeAreaView edges={['top']} style={s.screen}>
      <FlatList data={rows} keyExtractor={(r) => r.slot} renderItem={renderItem} ListHeaderComponent={header}
        contentContainerStyle={s.list} ItemSeparatorComponent={Sep} removeClippedSubviews initialNumToRender={4} windowSize={5}
        ListEmptyComponent={<T tone="muted" style={{ marginTop: 12 }}>Nothing logged yet. Tap Log and type it the way you say it.</T>} />
    </SafeAreaView>
  );
}
const Sep = () => <View style={{ height: 10 }} />;
const useStyles = makeStyles((t) => ({
  screen: { flex: 1, backgroundColor: t.c.bg },
  list: { padding: t.space.screen, paddingBottom: t.sizes.nav + t.space.xxl, gap: t.space.gap },
  avatar: { width: 36, height: 36, borderRadius: t.radius.full, backgroundColor: t.c.primarySoft, alignItems: 'center', justifyContent: 'center' },
  rings: { flexDirection: 'row', justifyContent: 'space-evenly' },
  big: { alignItems: 'center' },
}));
