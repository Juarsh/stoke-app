// Habit detail (build-plan item 14; spec §10.3; habits-v2/hb1-detail). Back, Edit (honey). Full name, meta line ("3 sets ×
// 15 reps · Every day"), the streak ("12 days", read "12 days in a row"; the one free miss per week is never shown), the
// Today row (same tick as the list), This week Mon–Sun (done sage ✓, today outlined, future faded dashed, missed warm grey,
// before the start date a dash); a past day in the last 7 can be tapped to log it late (Q14). "Log a different amount ›"
// (count / sets), "History ›" (the last 4 weeks, inline). "How to do it" needs a linked exercise, cut from v1. Archive
// keeps the history.
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, Vibration, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { T } from '@/components/ui';
import { addDays } from '@/lib/domain';
import { useHabits } from '@/lib/habits';
import { useLogDay } from '@/lib/useLogDay';
import { useStore } from '@/lib/store';
import { useTheme } from '@/theme';
import { dayLabel } from '../workout/history';
import { Box, Confirm, Header } from '../plans/parts';
import { AmountSheet } from './AmountSheet';
import { DAY_NAMES, daysCount, isDue, logDateError, logOf, metaLine, partialText, snapOf, streak, targetText, weekCells } from './model';

export function HabitDetail({ id }: { id: string }) {
  const t = useTheme(); const router = useRouter(); const hb = useHabits(); const st = useStore(); const today = useLogDay();
  const [amount, setAmount] = useState(false);
  const [history, setHistory] = useState(false);
  const [archive, setArchive] = useState(false);
  if (!hb.ready) return null;
  const h = hb.habitById(id);
  if (!h || h.archived_at) {
    return (
      <View style={{ flex: 1, backgroundColor: t.c.bg }}>
        <Header title="Habit" />
        <T tone="text2" style={{ padding: 20, fontSize: 15 }}>This habit isn’t on this phone any more.</T>
      </View>
    );
  }
  const s = hb.state;
  const n = streak(s, h, today);
  const log = logOf(s, h.id, today);
  const done = !!log?.done;
  const toggle = (date: string) => { const was = !!logOf(s, h.id, date)?.done; const e = hb.toggle(h.id, date, today); if (e) st.showNotice(e); else Vibration.vibrate(was ? 8 : 15); };
  const fgDone = t.dark ? '#15121B' : '#FFFFFF';
  const link = (title: string, onPress: () => void, first = false) => (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={title}
      style={({ pressed }) => ({ minHeight: 64, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, borderTopWidth: first ? 0 : 1, borderTopColor: t.c.lineSoft, backgroundColor: pressed ? t.c.card2 : 'transparent' })}>
      <T v="bodyStrong" style={{ flex: 1, fontSize: 17 }}>{title}</T>
      <Icon name={title === 'History' && history ? 'down' : 'chev'} color={t.c.text2} size={18} strokeWidth={2.2} />
    </Pressable>
  );
  const past = Array.from({ length: 28 }, (_, i) => addDays(today, -i)).filter((d) => d >= h.starts_on && (isDue(h, d) || logOf(s, h.id, d)));
  return (
    <View style={{ flex: 1, backgroundColor: t.c.bg }} testID="habit-detail">
      <Header title="" right={
        <Pressable onPress={() => router.push({ pathname: '/habit-form', params: { id: h.id } } as never)} accessibilityRole="button" accessibilityLabel={`Edit ${h.name}`}
          style={{ minHeight: 48, minWidth: 48, alignItems: 'flex-end', justifyContent: 'center' }}>
          <T v="bodyStrong" style={{ color: t.c.accentText, fontSize: 17 }}>Edit</T>
        </Pressable>} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40, gap: 14 }}>
        <View style={{ gap: 4 }}>
          <T v="title" accessibilityRole="header" style={{ fontSize: 32, lineHeight: 38 }}>{h.name}</T>
          <T tone="text2" style={{ fontSize: 15 }}>{metaLine(h)}</T>
        </View>
        <T v="headline" style={{ fontSize: 24, color: t.c.text2 }} accessibilityLabel={`${daysCount(n)} in a row`}>{daysCount(n)}</T>
        <Pressable onPress={() => toggle(today)} accessibilityRole="button"
          accessibilityLabel={done ? `Today, ${h.name}, done. Double-tap to undo` : `Today, ${h.name}${targetText(snapOf(h)) ? `, ${targetText(snapOf(h))}` : ''}, not done yet. Double-tap to mark done`}
          style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 16, minHeight: 80, paddingHorizontal: 18, borderRadius: t.radius.card,
            backgroundColor: done ? t.c.train : pressed ? t.c.card2 : t.c.card, borderWidth: done ? 0 : 1, borderColor: t.c.lineSoft })}>
          <View style={{ width: 32, height: 32, borderRadius: 9, borderWidth: done ? 0 : 2, borderColor: t.c.stateLine, alignItems: 'center', justifyContent: 'center' }}>
            {done ? <T style={{ color: fgDone, fontSize: 20 }}>✓</T> : null}
          </View>
          <View style={{ flex: 1 }}>
            <T v="bodyStrong" style={{ fontSize: 19, color: done ? fgDone : t.c.text }}>Today</T>
            {partialText(log) ?? targetText(snapOf(h)) ? <T style={{ fontSize: 14, color: done ? fgDone : t.c.text2 }}>{partialText(log) ?? targetText(log?.target_snapshot ?? snapOf(h))}</T> : null}
          </View>
        </Pressable>
        <T v="bodyStrong" accessibilityRole="header" style={{ fontSize: 17, marginTop: 4 }}>This week</T>
        <View style={{ flexDirection: 'row', gap: 6 }}>
          {weekCells(s, h, today).map((c, i) => {
            const can = !c.isToday && (c.cell === 'missed' || c.cell === 'done' || c.cell === 'off') && !logDateError(c.date, today);
            const state = c.cell === 'done' ? 'done' : c.cell === 'missed' ? 'missed' : c.cell === 'future' ? 'not yet' : c.cell === 'before' ? 'before the start' : c.cell === 'off' ? 'not planned' : 'not done yet';
            return (
              <View key={c.date} style={{ flex: 1, alignItems: 'center', gap: 6 }}>
                <T v={c.isToday ? 'bodyStrong' : 'body'} tone={c.isToday ? 'text' : 'text2'} style={{ fontSize: 13 }}>{c.isToday ? 'Today' : DAY_NAMES[i]}</T>
                <Pressable disabled={!can} onPress={() => toggle(c.date)} accessibilityRole={can ? 'button' : undefined} testID={`day-${c.date}`}
                  accessibilityLabel={`${dayLabel(c.date)}, ${state}${can ? (c.cell === 'done' ? '. Double-tap to undo' : '. Double-tap to log it') : ''}`}
                  style={{ width: '100%', aspectRatio: 1, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
                    backgroundColor: c.cell === 'done' ? t.c.train : c.cell === 'missed' ? t.c.card2 : c.cell === 'future' || c.cell === 'before' || c.cell === 'off' ? 'transparent' : t.c.card,
                    borderWidth: c.isToday ? 2 : c.cell === 'future' ? 1.5 : 0, borderStyle: c.cell === 'future' ? 'dashed' : 'solid',
                    borderColor: c.isToday ? t.c.text : t.c.lineSoft, opacity: c.cell === 'future' ? 0.7 : 1 }}>
                  {c.cell === 'done' ? <T style={{ color: fgDone, fontSize: 16 }}>✓</T> : c.cell === 'before' ? <T tone="muted" style={{ fontSize: 16 }}>–</T> : null}
                </Pressable>
              </View>
            );
          })}
        </View>
        <Box>
          {h.kind !== 'done' ? link('Log a different amount', () => setAmount(true), true) : null}
          {link('History', () => setHistory((x) => !x), h.kind === 'done')}
          {history ? (
            <View style={{ paddingHorizontal: 20, paddingBottom: 12 }} testID="habit-history">
              {past.map((d) => {
                const l = logOf(s, h.id, d);
                const what = l?.done ? `Done${targetText(l.target_snapshot) ? ` · ${targetText(l.target_snapshot)}` : ''}` : partialText(l) ?? (d === today ? 'Not yet' : 'Missed');
                return (
                  <View key={d} style={{ flexDirection: 'row', minHeight: 40, alignItems: 'center', borderTopWidth: 1, borderTopColor: t.c.lineSoft }} accessible accessibilityLabel={`${dayLabel(d)}: ${what}`}>
                    <T style={{ flex: 1, fontSize: 15 }}>{d === today ? 'Today' : dayLabel(d)}</T>
                    <T tone={l?.done ? 'text' : 'text2'} style={{ fontSize: 15 }}>{what}</T>
                  </View>
                );
              })}
            </View>
          ) : null}
        </Box>
        <Pressable onPress={() => setArchive(true)} accessibilityRole="button" accessibilityLabel="Archive habit" style={{ minHeight: 48, justifyContent: 'center', alignSelf: 'flex-start' }}>
          <T v="bodyStrong" style={{ fontSize: 15, color: t.c.text2 }}>Archive habit</T>
        </Pressable>
      </ScrollView>
      {amount ? <AmountSheet habitId={h.id} date={today} today={today} onClose={() => setAmount(false)} /> : null}
      <Confirm visible={archive} title={`Archive ${h.name}?`} body="It leaves Home and the Habits list. History is kept." keep="Keep" drop="Archive"
        onKeep={() => setArchive(false)} onDrop={() => { setArchive(false); hb.archive(h.id); router.back(); }} />
    </View>
  );
}
