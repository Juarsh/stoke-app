import { useRouter } from 'expo-router';
import { memo, useCallback, useEffect, useMemo } from 'react';
import { FlatList, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CoachCard } from '@/components/CoachCard';
import { FoodTile } from '@/components/FoodTile';
import { Glows } from '@/components/Gradient';
import { Bar, HeroArc } from '@/components/HeroArc';
import { Badge, Card, Row, T } from '@/components/ui';
import { flags } from '@/lib/config';
import type { FoodEntry } from '@/lib/domain';
import { localDate } from '@/lib/domain';
import { readTodaySteps } from '@/lib/health';
import { SLOT_LABEL } from '@/lib/labels';
import { useStore } from '@/lib/store';
import { useDay } from '@/lib/useDay';
import { ReviewLink } from '@/components/ReviewLink';
import { PendingRow } from '@/components/PendingRow';
import { parser } from '@/parser';
import { makeStyles, useTheme } from '@/theme';

const PlateTile = memo(function PlateTile({ e }: { e: FoodEntry }) {
  const s = useStyles();
  const name = e.custom_name || parser.dishById(e.dish_id ?? '')?.name || 'item';
  return (
    <Card style={s.tile}>
      <FoodTile seed={e.dish_id ?? e.custom_name} category={parser.dishById(e.dish_id ?? '')?.category} />
      <T v="bodyStrong" numberOfLines={1}>{name}</T>
      <T v="caption" tone="muted">{SLOT_LABEL[e.slot].slice(0, 1)} · {e.kcal.best}</T>
    </Card>
  );
});
const renderTile = ({ item }: { item: FoodEntry }) => <PlateTile e={item} />;
const keyOf = (e: FoodEntry) => e.id;

export default function Today() {
  const t = useTheme(); const s = useStyles(); const st = useStore(); const d = useDay(); const router = useRouter();
  const { setSteps, api } = st;
  useEffect(() => {
    readTodaySteps().then((n) => { if (n !== null) { setSteps(localDate(), n); api.putSteps(localDate(), n).catch(() => {}); } });
  }, [setSteps, api]);
  const first = (st.user?.name ?? '').split(' ')[0];
  const dateLabel = useMemo(() => new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }), []);
  const openSettings = useCallback(() => router.push('/settings'), [router]);
  const dietLabel = d.profile?.diet === 'veg' ? 'Veg' : d.profile?.diet === 'egg' ? 'Egg' : 'Non-veg';
  const protPct = d.proteinTarget ? d.tot.protein / d.proteinTarget : 0;
  return (
    <View style={{ flex: 1 }}>
      <Glows />
      <SafeAreaView edges={['top']} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={s.list} removeClippedSubviews>
          <Row style={{ justifyContent: 'space-between' }}>
            <View><T v="caption" tone="muted">{dateLabel}</T><T v="title">Namaste{first ? `, ${first}` : ''}</T></View>
            <Row>
              <Badge kind="gold" label={`🔥 ${d.streak.current}`} />
              <Pressable onPress={openSettings} accessibilityLabel="Open settings" style={s.avatar} hitSlop={8}>
                <T v="bodyStrong" tone="emChip">{(first || '?').slice(0, 1).toUpperCase()}</T>
              </Pressable>
            </Row>
          </Row>
          {d.reviewCount ? <ReviewLink date={d.date} n={d.reviewCount} /> : null}
          <HeroArc eaten={d.tot.kcal} target={d.kcalTarget} kcalLeft={d.kcalLeft} />
          <View style={s.pair}>
            <Card style={s.half}>
              <Row style={{ justifyContent: 'space-between' }}><T v="caption" tone="muted">Protein</T><T v="number">{Math.round(d.proteinLeft)} g left</T></Row>
              <Bar pct={protPct} from={t.c.accentFill} />
            </Card>
            {flags.steps ? (
              <Card style={s.half}>
                <Row style={{ justifyContent: 'space-between' }}><T v="caption" tone="muted">Steps</T><T v="number">{d.steps.toLocaleString('en-IN')}</T></Row>
                <Bar pct={d.steps / (d.profile?.stepsTarget ?? 8000)} from={t.c.emTintLine} />
                <T v="caption" tone="muted">≈{d.burn} kcal · {d.profile?.addStepKcal ? 'in budget' : 'not in budget'}</T>
              </Card>
            ) : null}
          </View>
          <CoachCard kcalLeft={d.kcalLeft} proteinLeft={d.proteinLeft} picks={d.picks} dietLabel={dietLabel} />
          <Row style={{ justifyContent: 'space-between', marginTop: 4 }}>
            <T v="headline">Today’s plate</T>
            {d.streak.freezeJustUsed ? <T v="caption" tone="freeze">❄ Freeze saved your {d.streak.current}-day streak</T>
              : d.streak.current === 0 && d.loggedDates.size > 0 ? <T v="caption" tone="muted">Streak paused. Start again today.</T> : null}
          </Row>
          {d.pending.map((f) => <PendingRow key={f.id} label={f.span} state={d.offline ? 'offline' : 'estimating'} />)}
          {d.entries.length || d.pending.length || d.reviewCount ? null : <Card><T tone="muted">Nothing logged yet. Tap Log and type it the way you say it.</T></Card>}
          {d.entries.length ? (
            <FlatList horizontal data={d.entries} keyExtractor={keyOf} renderItem={renderTile} showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 10 }} initialNumToRender={4} windowSize={3} removeClippedSubviews />
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}
const useStyles = makeStyles((t) => ({
  list: { padding: t.space.screen, paddingBottom: t.sizes.nav + t.space.xxl * 2, gap: t.space.gap },
  avatar: { width: 36, height: 36, borderRadius: t.radius.full, backgroundColor: t.c.tint, alignItems: 'center', justifyContent: 'center' },
  pair: { flexDirection: 'row', gap: t.space.gap },
  half: { flex: 1 },
  tile: { width: 120, gap: 6 },
}));
