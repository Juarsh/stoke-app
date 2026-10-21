// Old v3.2 Today screen, parked at /today (reached from Food) until the food timeline (item 6) replaces it. v3.2 Today (frame 3): greeting + streak chip, review card, ring hero, protein/steps rows, Fill card, Today's plate rows.
import { useRouter } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { FoodIcon, SLOT_ICON } from '@/components/FoodIcon';
import { Glows } from '@/components/Gradient';
import { Bar } from '@/components/HeroArc';
import { Icon } from '@/components/Icon';
import { PendingRow } from '@/components/PendingRow';
import { ReviewLink } from '@/components/ReviewLink';
import { RingHero } from '@/components/RingHero';
import { ServerNoteRow } from '@/components/ServerNoteRow';
import { SyncFailedRow } from '@/components/SyncFailedRow';
import { PICK_TYPE_COPY, VariantPickSheet } from '@/components/VariantPickSheet';
import { Card, Row, T } from '@/components/ui';
import type { Suggestion } from '@/lib/coach';
import { flags } from '@/lib/config';
import { countedNums, displayLabel, displayName, entryLabel, FoodEntry, greeting, dayOf, plateRows, Slot } from '@/lib/domain';
import { readTodaySteps } from '@/lib/health';
import { AMOUNT_UNKNOWN, SLOT_LABEL } from '@/lib/labels';
import { kc } from '@/lib/format';
import { useStore } from '@/lib/store';
import { useDay } from '@/lib/useDay';
import { parser } from '@/parser';
import { makeStyles, useTheme } from '@/theme';

// the same display name as Review (rows: "Zarda pulao"; the plate summary lists names as they read: "poha, chai")
const nameOf = (e: FoodEntry) => entryLabel(e);
const plateName = (e: FoodEntry) => displayName(e.custom_name || '', e.dish_id);

const FillCard = memo(function FillCard({ kcal, protein, picks, diet }: { kcal: number; protein: number; picks: Suggestion[]; diet: string }) {
  const s = useStyles(); const t = useTheme(); const router = useRouter();
  if (kcal <= 0 || !picks.length) return null;
  return (
    <View style={s.fill}>
      <Row style={{ gap: 8 }}><Icon name="coach" color={t.c.em} size={16} /><T v="headline">Fill {Math.round(kcal).toLocaleString('en-IN')} kcal · {Math.round(protein)} g protein</T></Row>
      <T v="caption" tone="text2">{diet} picks from our dish table · estimates</T>
      {picks.map((p) => (
        <Pressable key={p.label} style={s.fillRow} onPress={() => router.push({ pathname: '/log', params: { prefill: p.label } })}
          accessibilityRole="button" accessibilityLabel={`Log ${p.label}, ${p.kcal} calories`}>
          <T style={{ flex: 1 }}>{p.label} <T v="caption" tone="muted">· {p.kcal} kcal</T></T>
          <T v="bodyStrong" tone="em">+ Log</T>
        </Pressable>
      ))}
    </View>
  );
});

export default function Today() {
  const t = useTheme(); const s = useStyles(); const st = useStore(); const d = useDay(); const router = useRouter();
  const { setSteps, api } = st;
  useEffect(() => {
    readTodaySteps().then((n) => { if (n !== null) { setSteps(dayOf(), n); api.putSteps(dayOf(), n).catch(() => {}); } });
  }, [setSteps, api]);
  const first = (st.user?.name ?? '').split(' ')[0];
  const dateLabel = useMemo(() => new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }), []);
  const openSettings = useCallback(() => router.push('/settings'), [router]);
  const dietLabel = d.profile?.diet === 'veg' ? 'Veg' : d.profile?.diet === 'egg' ? 'Egg' : 'Non-veg';
  const protPct = d.proteinTarget ? d.tot.protein / d.proteinTarget : 0;
  const reviewSlots = new Set<Slot>([...d.reviews.map((e) => e.slot), ...d.stale.map((f) => f.slot)]);
  const reviewSlot = reviewSlots.size === 1 ? SLOT_LABEL[[...reviewSlots][0]] : undefined;
  const rows = useMemo(() => plateRows(d.entries, plateName), [d.entries]);
  const stepsK = Math.round((d.profile?.stepsTarget ?? 8000) / 1000);
  // rg6 F4: the row the user is picking a type for (variant_required on a sync)
  const [picking, setPicking] = useState<string | null>(null);
  const pickRow = picking ? st.entries.find((e) => e.id === picking && e.sync_error === 'variant_required') ?? null : null;
  // rg6 F1: rows the server saved with other numbers than the phone sent; they show (and count) the server's version
  const notes = d.entries.filter((e) => e.server_note && !e.needs_review && !e.deleted_at);
  return (
    <View style={{ flex: 1 }}>
      <Glows />
      <SafeAreaView edges={['top']} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={s.list}>
          <Row style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
            <View style={{ flex: 1 }}>
              <T v="caption" tone="muted">{dateLabel}</T>
              <T v="title" numberOfLines={1}>{greeting()}{first ? `, ${first}` : ''}</T>
            </View>
            <Pressable onPress={openSettings} accessibilityRole="button" accessibilityLabel={`${d.streak.current}-day streak. Open settings`} style={s.streak} hitSlop={8}>
              <T v="label" tone="gold" numberOfLines={1}>🔥 {d.streak.current} {d.streak.current === 1 ? 'day' : 'days'}</T>
            </Pressable>
          </Row>
          {d.reviewCount ? <ReviewLink date={d.date} n={d.reviewCount} right={reviewSlot} /> : null}
          <RingHero eaten={d.tot.kcal} target={d.kcalTarget} kcalLeft={d.kcalLeft} proteinLeft={d.proteinLeft} />
          <View style={s.pair}>
            <View style={{ flex: 1, gap: 6 }}>
              <T v="caption" tone="muted">Protein</T>
              <Bar pct={protPct} from={t.c.em} />
            </View>
            {flags.steps ? (
              <View style={{ flex: 1, gap: 6 }}>
                <Row style={{ justifyContent: 'space-between' }}><T v="caption" tone="muted">Steps</T><T v="caption" tone="muted">{d.steps.toLocaleString('en-IN')} / {stepsK}k</T></Row>
                <Bar pct={d.steps / (d.profile?.stepsTarget ?? 8000)} from={t.c.accentFill} />
                <T v="micro" tone="muted">≈{d.burn} kcal · {d.profile?.addStepKcal ? 'in budget' : 'not in budget'}</T>
              </View>
            ) : null}
          </View>
          <FillCard kcal={d.kcalLeft} protein={d.proteinLeft} picks={d.picks} diet={dietLabel} />
          <Row style={{ justifyContent: 'space-between', marginTop: 4 }}>
            <T v="bodyStrong">Today’s plate</T>
            {d.streak.freezeJustUsed ? <T v="caption" tone="muted">❄ Freeze saved your streak</T>
              : d.streak.current === 0 && d.loggedDates.size > 0 ? <T v="caption" tone="muted">Streak paused. Start again today.</T> : null}
          </Row>
          {d.reviews.map((e) => (
            <Pressable key={e.id} onPress={() => router.push({ pathname: '/review', params: { date: d.date } })} style={s.reviewRow} accessibilityRole="button"
              accessibilityLabel={`${nameOf(e)}, needs review, not counted${e.server_note ? `. ${e.server_note}` : ''}`}>
              <View style={{ flex: 1, gap: 2 }}>
                <Row style={{ gap: 10 }}>
                  <T style={{ flex: 1 }} numberOfLines={1}>{SLOT_LABEL[e.slot]} · {e.review_item ? displayLabel(e.review_item.name, e.review_item.dish_id) : nameOf(e)}</T>
                  <T v="caption" tone="muted">— kcal · needs review</T>
                </Row>
                {e.server_note ? <T v="caption" tone="warn" testID="server-note">{e.server_note}</T> : null}
              </View>
            </Pressable>
          ))}
          {d.syncFailed.map((e) => (
            <SyncFailedRow key={`sync-${e.id}`} title={`${SLOT_LABEL[e.slot]} · ${nameOf(e)}${e.deleted_at ? ' (deleted)' : ''}`}
              kcal={e.deleted_at && !e.delete_failed ? undefined : countedNums(e).kcal} notCounted={(!e.deleted_at || !!e.delete_failed) && !!e.server_failed && !e.server_counts} retrying={!!e.sync_retrying} reason={e.sync_reason}
              line={e.sync_error === 'variant_required' && !e.deleted_at ? PICK_TYPE_COPY : undefined}
              onRetry={() => (e.sync_error === 'variant_required' && !e.deleted_at ? setPicking(e.id) : st.retrySync(e.id))} />
          ))}
          {notes.map((e) => (
            <ServerNoteRow key={`note-${e.id}`} title={`${SLOT_LABEL[e.slot]} · ${nameOf(e)}${e.amount_unknown ? ` · ${AMOUNT_UNKNOWN}` : ''}`}
              kcal={e.amount_unknown && !e.server_counts ? undefined : countedNums(e).kcal} note={e.server_note!} onDismiss={() => st.clearServerNote(e.id)} />
          ))}
          {d.pending.map((f) => <PendingRow key={f.id} label={`${SLOT_LABEL[f.slot]} · ${f.span}`} state={d.offline ? 'offline' : 'estimating'} />)}
          <View>
            {rows.map((r, i) => (
              <Pressable key={r.slot} style={[s.plateRow, i > 0 && s.sep]} accessibilityRole="button"
                accessibilityLabel={r.n ? `${SLOT_LABEL[r.slot]}: ${r.names}, ${r.kcal} calories` : `Add ${SLOT_LABEL[r.slot]}`}
                onPress={() => router.push(r.n ? '/progress' : { pathname: '/log', params: { slot: r.slot as Slot } })}>
                <FoodIcon name={SLOT_ICON[r.slot] ?? 'lunch'} size={24} />
                <T v="bodyStrong" style={{ width: 84 }}>{SLOT_LABEL[r.slot]}</T>
                {r.n ? (
                  <>
                    <T tone="muted" numberOfLines={1} style={{ flex: 1 }}>{r.names}</T>
                    <T v="number">{kc(r.kcal)}</T>
                    <Icon name="chevron" color={t.c.muted} size={18} />
                  </>
                ) : <T v="bodyStrong" tone="em" style={{ flex: 1 }}>+ add</T>}
              </Pressable>
            ))}
          </View>
          {d.entries.length || d.pending.length || d.reviewCount ? null : <Card><T tone="muted">Nothing logged yet. Tap Log and type it the way you say it.</T></Card>}
        </ScrollView>
        <VariantPickSheet entry={pickRow} onPick={(dish) => st.pickVariant(pickRow!.id, dish)} onClose={() => setPicking(null)} />
      </SafeAreaView>
    </View>
  );
}
const useStyles = makeStyles((t) => ({
  list: { padding: t.space.screen, paddingBottom: t.sizes.nav + t.space.xxl * 2, gap: t.space.md },
  streak: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: t.radius.full, backgroundColor: t.c.tintGold, minHeight: 32, justifyContent: 'center' },
  pair: { flexDirection: 'row', gap: t.space.lg },
  fill: { backgroundColor: t.c.accentTint, borderRadius: t.radius.card, padding: t.space.cardH, gap: 4, borderWidth: 1, borderColor: t.c.emTintLine },
  fillRow: { flexDirection: 'row', alignItems: 'center', minHeight: 44, borderTopWidth: 1, borderTopColor: t.c.emTintLine, gap: 8 },
  plateRow: { flexDirection: 'row', alignItems: 'center', minHeight: 48, gap: 10 },
  sep: { borderTopWidth: 1, borderTopColor: t.c.lineSoft },
  reviewRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
}));
