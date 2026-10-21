// Home (build-plan item 3, spec §3, full-b2 home / home-empty / home-steps-off): greeting + streak chip, Food card
// (kcal eaten and left, protein bar, steps bar), Today's workout ink card (item 9), Last 7 days, Coach tip. Habits B2 comes
// with item 13; nothing stands in for it here. Everything is read from the phone's store (offline).
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Glows } from '@/components/Gradient';
import { Icon } from '@/components/Icon';
import { ReviewLink } from '@/components/ReviewLink';
import { Button, Card, Row, T } from '@/components/ui';
import { flags } from '@/lib/config';
import { greeting, dayOf } from '@/lib/domain';
import { connectSteps, getHealthConnect, readTodaySteps, StepsStatus, stepsStatus } from '@/lib/health';
import { useStore } from '@/lib/store';
import { useDay } from '@/lib/useDay';
import { useLogDay } from '@/lib/useLogDay';
import { DISHES } from '@/parser';
import { coachTip, foodCard, homeDate, lastLine, weekStrip } from '@/features/home/model';
import { TodayCard } from '@/features/plans/TodayCard';
import { makeStyles, useTheme } from '@/theme';

const n = (x: number) => Math.round(x).toLocaleString('en-IN');
const EXAMPLE = '2 roti dal sabzi';

function Bar({ pct, color, outline }: { pct: number; color: string; outline?: boolean }) {
  const t = useTheme();
  return (
    <View style={{ height: 8, borderRadius: 4, backgroundColor: outline ? 'transparent' : t.c.track, overflow: 'hidden',
      ...(outline ? { borderWidth: 1.5, borderColor: t.c.over } : {}) }}>
      {outline ? null : <View style={{ width: `${Math.round(Math.max(0, Math.min(1, pct)) * 100)}%`, height: '100%', backgroundColor: color, borderRadius: 4 }} />}
    </View>
  );
}

/** Steps: never prompts by itself; reads only when Health Connect already allows it. */
function useSteps() {
  const st = useStore(); const { setSteps, api } = st;
  const [status, setStatus] = useState<StepsStatus | null>(null);
  const refresh = useCallback(async () => {
    const s = await stepsStatus(); setStatus(s);
    if (s !== 'connected') return;
    const v = await readTodaySteps();
    if (v !== null) { setSteps(dayOf(), v); api.putSteps(dayOf(), v).catch(() => {}); }
  }, [setSteps, api]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { status, refresh };
}

function ConnectStepsSheet({ visible, status, onClose, onConnected }: { visible: boolean; status: StepsStatus | null; onClose: () => void; onConnected: () => void }) {
  const t = useTheme(); const s = useStyles();
  const missing = status === 'unavailable';
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: t.c.scrim }} onPress={onClose} accessibilityLabel="Close" />
      <View style={s.sheet}>
        <View style={s.handle} />
        <T v="title" style={{ fontSize: 22 }} accessibilityRole="header">Connect steps</T>
        <T style={{ fontSize: 15, lineHeight: 22 }}>See your daily steps here. We only read steps from Health Connect.</T>
        <T tone="text2" style={{ fontSize: 15, lineHeight: 22 }}>Next, Android will ask you to allow steps.</T>
        <T tone="muted" style={{ fontSize: 14 }}>You can turn this off any time in Settings.</T>
        <Button title={missing ? 'Get Health Connect' : 'Connect'} style={{ marginTop: 8 }}
          onPress={async () => { if (missing) { void getHealthConnect(); onClose(); return; } const ok = await connectSteps(); onClose(); if (ok) onConnected(); }} />
        <Button title="Not now" kind="ghost" onPress={onClose} />
      </View>
    </Modal>
  );
}

export default function Home() {
  const t = useTheme(); const s = useStyles(); const st = useStore(); const today = useLogDay(); const d = useDay(today); const router = useRouter();
  const steps = useSteps();
  const [sheet, setSheet] = useState(false);
  const food = foodCard(d.entries, d.kcalTarget, d.proteinTarget);
  const last = lastLine(d.entries);
  const strip = useMemo(() => weekStrip(st.entries, d.date, d.kcalTarget), [st.entries, d.date, d.kcalTarget]);
  const tip = coachTip({ eaten: food.eaten, kcalLeft: food.left, over: food.over, proteinLeft: Math.max(0, food.proteinTarget - food.protein),
    kcalTarget: d.kcalTarget, proteinTarget: d.proteinTarget, diet: d.profile?.diet ?? 'veg', dishes: DISHES });
  const name = st.user?.name ?? '';
  const first = name.split(' ')[0];
  const initials = name.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
  const dateLabel = homeDate(d.date);
  const newUser = st.entries.length === 0;
  const stepsTarget = d.profile?.stepsTarget ?? 8000;
  const showSteps = flags.steps && (steps.status === 'connected' || d.steps > 0);
  const log = (prefill?: string) => router.push(prefill ? { pathname: '/log', params: { prefill } } : '/log-food');
  return (
    <View style={{ flex: 1 }}>
      <Glows />
      <SafeAreaView edges={['top']} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={s.list}>
          <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <View style={{ flex: 1, gap: 2 }}>
              <T v="caption" tone="muted" style={{ fontSize: 13 }}>{dateLabel}</T>
              <T v="title" style={{ fontSize: 26, lineHeight: 32 }}>{newUser ? 'Welcome' : greeting()}{first ? `, ${first}` : ''}</T>
            </View>
            <Pressable onPress={() => router.push('/settings')} accessibilityRole="button" accessibilityLabel="Settings" style={s.avatar}>
              {initials ? <T v="bodyStrong" tone="text2">{initials}</T> : <Icon name="circle" color={t.c.text2} size={20} />}
            </Pressable>
          </Row>
          <Row style={{ flexWrap: 'wrap' }}>
            <View style={s.streak}>
              <Icon name="flame" color={t.c.accentText} size={13} />
              <T v="label" tone="accentText" style={{ fontSize: 13 }}>{d.streak.current > 0 ? `${d.streak.current}-day streak` : 'Start your streak today'}</T>
            </View>
          </Row>
          {d.reviewCount ? <ReviewLink date={d.date} n={d.reviewCount} /> : null}

          <Card style={{ padding: 16, gap: 10 }}>
            <Row style={{ justifyContent: 'space-between' }}>
              <Row style={{ gap: 6 }}><View style={{ width: 9, height: 9, borderRadius: 2, backgroundColor: t.c.food }} /><T v="eyebrow" style={{ color: t.c.foodText, fontSize: 12 }}>Food</T></Row>
              <T v="caption" tone="muted" style={{ fontSize: 13 }}>Goal {n(food.kcalTarget)} kcal</T>
            </Row>
            <Row style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
              {/* "kcal left" drops under the number when it doesn't fit (full-b2 notes, 1.3x) */}
              <Row style={{ alignItems: 'baseline', columnGap: 8, flexWrap: 'wrap', flex: 1, minWidth: 0 }} accessible
                accessibilityLabel={food.isOver ? `${n(food.over)} calories over` : `${n(food.left)} calories left`}>
                <T v="display" style={{ fontSize: 44, lineHeight: 50, letterSpacing: -1.2, color: food.isOver ? t.c.over : t.c.text }}>{n(food.isOver ? food.over : food.left)}</T>
                <T v="bodyStrong" tone={food.isOver ? 'over' : 'text'} style={{ fontSize: 16 }}>{food.isOver ? 'kcal over' : 'kcal left'}</T>
              </Row>
              <Pressable onPress={() => log()} accessibilityRole="button" accessibilityLabel="Log food" style={s.logBtn}>
                <Icon name="plus" color={t.c.text} size={16} strokeWidth={2.4} /><T v="bodyStrong" style={{ fontSize: 15 }}>Log food</T>
              </Pressable>
            </Row>
            <Bar pct={food.kcalPct} color={food.isOver ? t.c.over : t.c.food} />
            {food.eaten > 0 || last ? (
              <Row style={{ justifyContent: 'space-between', flexWrap: 'wrap', columnGap: 10 }}>
                <T v="caption" tone="text2" style={{ fontSize: 13 }}>{n(food.eaten)} eaten</T>
                {last ? <T v="caption" tone="text2" style={{ fontSize: 13 }}>{last}</T> : null}
              </Row>
            ) : (
              <Row style={{ flexWrap: 'wrap', gap: 8 }}>
                <T v="caption" tone="text2" style={{ fontSize: 13 }}>Nothing logged yet. Try</T>
                <Pressable onPress={() => log(EXAMPLE)} accessibilityRole="button" accessibilityLabel={`Log ${EXAMPLE}`} style={s.example}>
                  <T v="bodyStrong" style={{ fontSize: 14 }}>{EXAMPLE}</T>
                </Pressable>
              </Row>
            )}
            <Row style={{ gap: 16, alignItems: 'flex-start', marginTop: 4 }}>
              <View style={{ flex: 1, gap: 6 }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <T v="bodyStrong" style={{ fontSize: 14 }}>Protein</T>
                  <T v="caption" tone="text2" style={{ fontSize: 13 }}><T v="bodyStrong" style={{ fontSize: 14 }}>{n(food.protein)}</T> / {n(food.proteinTarget)} g</T>
                </Row>
                <Bar pct={food.proteinPct} color={t.c.food} />
              </View>
              {flags.steps ? (
                <View style={{ flex: 1, gap: 6 }}>
                  {showSteps ? (
                    <>
                      <Row style={{ justifyContent: 'space-between' }}>
                        <T v="bodyStrong" style={{ fontSize: 14 }}>Steps</T>
                        <T v="caption" tone="text2" style={{ fontSize: 13 }}><T v="bodyStrong" style={{ fontSize: 14 }}>{n(d.steps)}</T> / {n(stepsTarget)}</T>
                      </Row>
                      <Bar pct={stepsTarget > 0 ? d.steps / stepsTarget : 0} color={t.c.text2} />
                    </>
                  ) : (
                    <Row style={{ justifyContent: 'space-between', flexWrap: 'wrap', columnGap: 6, marginTop: -13, marginBottom: -13 }}>
                      <T v="bodyStrong" style={{ fontSize: 14 }}>Steps</T>
                      <Pressable onPress={() => setSheet(true)} accessibilityRole="button" accessibilityLabel="Connect steps" style={{ minHeight: 48, justifyContent: 'center' }} hitSlop={4}>
                        <T tone="text2" style={{ fontSize: 14, textDecorationLine: 'underline' }}>Connect steps ›</T>
                      </Pressable>
                    </Row>
                  )}
                </View>
              ) : null}
            </Row>
          </Card>

          <TodayCard date={d.date} />

          <Card style={{ gap: 10 }}>
            <Row style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <T v="bodyStrong" style={{ fontSize: 15 }}>Last 7 days</T>
              <T v="caption" tone="muted" style={{ fontSize: 13 }}>{strip.pastDays ? `On target ${strip.onTarget} of ${strip.pastDays} ${strip.pastDays === 1 ? 'day' : 'days'}` : 'Starts today · fills in as you log'}</T>
            </Row>
            <Row style={{ gap: 6, justifyContent: 'flex-end' }}>
              {strip.days.map((day) => (
                <View key={day.date} style={{ flex: 1, maxWidth: 52, gap: 8, alignItems: 'stretch' }} accessible
                  accessibilityLabel={`${day.label}: ${day.state === 'none' ? 'nothing logged' : `${n(day.kcal)} calories${day.state === 'over' ? ', over target' : day.state === 'on' ? ', on target' : ''}`}`}>
                  <T v="label" tone={day.state === 'today' ? 'text' : 'text2'} style={{ textAlign: 'center', fontSize: 13, fontWeight: day.state === 'today' ? '700' : '600' }}>{day.label}</T>
                  {day.state === 'over' ? <Bar pct={1} color={t.c.over} outline />
                    : <Bar pct={day.state === 'on' ? 1 : day.state === 'today' ? day.pct : 0} color={day.state === 'today' && day.kcal > d.kcalTarget ? t.c.over : t.c.food} />}
                </View>
              ))}
            </Row>
            {strip.pastDays ? (
              <Row style={{ gap: 14, flexWrap: 'wrap' }}>
                <Row style={{ gap: 6 }}><View style={{ width: 14, height: 5, borderRadius: 3, backgroundColor: t.c.food }} /><T v="caption" tone="text2" style={{ fontSize: 13 }}>Calories on target</T></Row>
                <Row style={{ gap: 6 }}><View style={{ width: 14, height: 5, borderRadius: 3, borderWidth: 1.5, borderColor: t.c.over }} /><T v="caption" tone="text2" style={{ fontSize: 13 }}>Over</T></Row>
              </Row>
            ) : null}
          </Card>

          <Pressable onPress={() => router.push('/coach')} accessibilityRole="button" accessibilityLabel={`Coach: ${tip} Open Coach`} style={s.coach}>
            <Icon name="spark" color={t.c.accentText} size={18} />
            <T style={{ flex: 1, fontSize: 14, lineHeight: 20 }}><T v="bodyStrong" style={{ fontSize: 14 }}>Coach:</T> {tip}</T>
            <Icon name="chev" color={t.c.accentText} size={18} strokeWidth={2.2} />
          </Pressable>
        </ScrollView>
      </SafeAreaView>
      <ConnectStepsSheet visible={sheet} status={steps.status} onClose={() => setSheet(false)} onConnected={() => void steps.refresh()} />
    </View>
  );
}
const useStyles = makeStyles((t) => ({
  list: { padding: t.space.screen, paddingBottom: t.sizes.nav + t.space.xxl * 2, gap: 12 },
  avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: t.c.card2, alignItems: 'center', justifyContent: 'center' },
  streak: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, minHeight: 34, borderRadius: t.radius.full, backgroundColor: t.c.tintGold },
  logBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 48, paddingHorizontal: 12, borderRadius: t.radius.tile, borderWidth: 1.5, borderColor: t.c.cardLine, backgroundColor: t.c.card2 },
  example: { minHeight: 40, paddingHorizontal: 14, justifyContent: 'center', borderRadius: t.radius.full, borderWidth: 1.5, borderColor: t.c.cardLine },
  coach: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 12, paddingLeft: 14, paddingRight: 8, borderRadius: t.radius.card, backgroundColor: t.c.accentTint },
  sheet: { backgroundColor: t.c.sheet, borderTopLeftRadius: t.radius.sheet, borderTopRightRadius: t.radius.sheet, padding: 20, paddingBottom: 32, gap: 10,
    ...(t.dark ? { borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)' } : {}) },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: t.c.handle, alignSelf: 'center', marginBottom: 6 },
}));
