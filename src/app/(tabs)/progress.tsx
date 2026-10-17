import { memo, useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Glows } from '@/components/Gradient';
import { EditSheet } from '@/components/ItemEditor';
import { Card, Row, T } from '@/components/ui';
import { addDays, counted, countedNums, displayName, onServer, entryLabel, toReview, dayTotals, FoodEntry, localDate, Slot } from '@/lib/domain';
import { isStale, pendingFor, PendingFood } from '@/lib/syncQueue';
import { ReviewLink } from '@/components/ReviewLink';
import { PendingRow } from '@/components/PendingRow';
import { portionLabel, SLOT_LABEL } from '@/lib/labels';
import { Icon } from '@/components/Icon';
import { useStore } from '@/lib/store';
import { useDay } from '@/lib/useDay';
import { DISH_TABLE_VERSION, Item, parser } from '@/parser';
import { makeStyles, useTheme } from '@/theme';

/** Saved entry -> editable Item view. Numbers come from the snapshot, not the table. */
function asItem(e: FoodEntry): Item {
  return { dish_id: e.dish_id ?? '', name: displayName(e.custom_name || '', e.dish_id), matched_text: e.raw_text,
    quantity: e.qty, unit: e.unit, grams: 0, oil_level: e.oil_level, kcal: e.kcal, protein_g: e.protein_g,
    source: 'table', data_source: e.source === 'table' ? (parser.dishById(e.dish_id ?? '')?.source ?? 'estimate') : e.source, source_note: e.source_note,
    fuzzy: false, ai_estimate: e.source === 'ai' || e.source === 'custom', carbs_g: e.carbs_g ?? 0, fat_g: e.fat_g ?? 0, needs_confirmation: false, default_portion: false, span_start: 0, span_end: e.raw_text.length };
}

type Day = { date: string; kcal: number; protein: number; entries: FoodEntry[]; reviews: number; pending: PendingFood[] };
const fmt = (n: number) => Math.round(n).toLocaleString('en-IN');
const asDate = (iso: string) => new Date(iso + 'T12:00:00');
const dayLabel = (iso: string, today: string) => iso === today ? 'Today' : asDate(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');

/** v3.2 frame 6 day row: "Sun 11 Oct / 5 items" · "1,980 kcal · 76 g / 120 kcal over" ›; tap to open the day's items. */
const DayRow = memo(function DayRow({ day, today, target, first, last, onPick }: { day: Day; today: string; target: number; first: boolean; last: boolean; onPick: (e: FoodEntry) => void }) {
  const t = useTheme(); const s = useStyles();
  const [open, setOpen] = useState(false);
  const items = day.entries.filter(counted);
  const over = target > 0 ? day.kcal - target : 0;
  return (
    <View style={[s.dayCard, first && s.top, last && s.bottom]}><View style={!first && s.sep}>
      <Pressable onPress={() => setOpen(!open)} style={s.dayRow} accessibilityRole="button" accessibilityState={{ expanded: open }}
        accessibilityLabel={`${dayLabel(day.date, today)}, ${items.length} items, ${fmt(day.kcal)} calories, ${fmt(day.protein)} grams protein`}>
        <View style={{ flex: 1 }}>
          <T v="bodyStrong">{dayLabel(day.date, today)}</T>
          <T v="caption" tone="muted">{items.length} {items.length === 1 ? 'item' : 'items'}</T>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <T v="bodyStrong">{fmt(day.kcal)} kcal · {fmt(day.protein)} g</T>
          {over > 0 ? <T v="caption" tone="muted">{fmt(over)} kcal over</T> : null}
        </View>
        <Icon name="chevron" color={t.c.text2} size={18} />
      </Pressable>
      {day.reviews ? <ReviewLink date={day.date} n={day.reviews} /> : null}
      {day.pending.map((f) => <PendingRow key={f.id} label={`${SLOT_LABEL[f.slot]} · ${f.span}`} state="offline" />)}
      {open ? items.map((e) => (
        <Pressable key={e.id} onPress={() => onPick(e)} accessibilityRole="button" accessibilityLabel={`Edit ${entryLabel(e)}`} style={s.entry}>
          <T tone="text2" style={{ flex: 1 }} numberOfLines={1}>{SLOT_LABEL[e.slot]} · {displayName(e.custom_name || '', e.dish_id)}{e.delete_failed ? ' (deleted)' : ''} · {portionLabel(e.qty, e.unit)}</T>
          <T v="number">{fmt(e.delete_failed ? countedNums(e).kcal : e.kcal.best)}</T>
        </Pressable>
      )) : null}
    </View></View>
  );
});

export default function Progress() {
  const st = useStore(); const d = useDay(); const s = useStyles(); const t = useTheme();
  const [editing, setEditing] = useState<FoodEntry | null>(null);
  const [editError, setEditError] = useState('');
  const [slot, setSlot] = useState<Slot>('lunch');
  const today = localDate();
  const days = useMemo<Day[]>(() => {
    const by = new Map<string, FoodEntry[]>();
    for (const e of st.entries) if (onServer(e)) by.set(e.local_date, [...(by.get(e.local_date) ?? []), e]);
    const pend = pendingFor(st.queue);
    for (const f of pend) if (!by.has(f.local_date)) by.set(f.local_date, []);
    by.delete(today); // today lives on the Today tab (frame 6 lists past days only)
    return [...by.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([date, entries]) => ({
      date, entries, ...dayTotals(entries), reviews: entries.filter(toReview).length, pending: pend.filter((f) => f.local_date === date && !isStale(f)) })).map((x) => ({ ...x, reviews: x.reviews + pend.filter((f) => f.local_date === x.date && isStale(f)).length }));
  }, [st.entries, st.queue, today]);
  // month view, Monday-first: from the Monday on/before the 1st through the Sunday of this week
  const cal = useMemo(() => {
    const first = today.slice(0, 8) + '01';
    const back = (asDate(first).getDay() + 6) % 7, fwd = 6 - ((asDate(today).getDay() + 6) % 7);
    const out: string[] = [];
    for (let x = addDays(first, -back); x <= addDays(today, fwd); x = addDays(x, 1)) out.push(x);
    return out;
  }, [today]);
  const month = asDate(today).toLocaleDateString('en-GB', { month: 'long' });
  // a flagged delete (rg9 B3) is not edited: tapping it retries the delete
  const onPick = useCallback((e: FoodEntry) => { if (e.delete_failed) { st.retrySync(e.id); return; } setSlot(e.slot); setEditing(e); }, [st]);
  const weekAgo = addDays(today, -6);
  const lastFreeze = [...d.streak.frozenDays].sort().reverse().find((x) => x >= weekAgo);
  const header = (
    <View style={{ gap: 12, marginBottom: 12 }}>
      <T v="title">Progress</T>
      <Card>
        <Row style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <View>
            <T v="label" tone="gold">🔥 Current streak</T>
            <Row style={{ alignItems: 'baseline', gap: 6 }}><T v="displayXl">{d.streak.current}</T><T tone="text2">{d.streak.current === 1 ? 'day' : 'days'}</T></Row>
          </View>
          <View style={{ alignItems: 'flex-end', gap: 2 }}>
            <T v="caption" tone="muted">Best</T>
            <T v="number">{d.streak.best}</T>
            <T v="caption" tone="text2">{lastFreeze ? `❄ Freeze used ${asDate(lastFreeze).toLocaleDateString('en-GB', { weekday: 'short' })}` : '❄ 1 freeze a week'}</T>
            <T v="caption" tone="text2">Resets Monday</T>
          </View>
        </Row>
      </Card>
      <Row style={{ justifyContent: 'space-between' }}><T v="bodyStrong">{month}</T><T v="caption" tone="muted" style={{ letterSpacing: 2 }}>MTWTFSS</T></Row>
      <View style={s.grid}>
        {cal.map((day) => {
          const logged = d.loggedDates.has(day), frozen = d.streak.frozenDays.includes(day), isToday = day === today;
          return (
            <View key={day} style={[s.cell, { backgroundColor: logged ? t.c.em : frozen ? t.c.tint : t.c.track }, isToday && !logged && { borderWidth: 1.5, borderColor: t.c.em, backgroundColor: t.c.card }]}
              accessibilityLabel={`${day}: ${logged ? 'logged' : frozen ? 'freeze used' : 'not logged'}`}>
              <T v="label" tone={logged ? 'onGrad' : frozen ? 'em' : isToday ? 'text' : 'muted'}>{frozen ? '❄' : String(Number(day.slice(8)))}</T>
            </View>
          );
        })}
      </View>
    </View>
  );
  return (
    <View style={{ flex: 1 }}><Glows /><SafeAreaView edges={['top']} style={s.screen}>
      <FlatList data={days} keyExtractor={(x) => x.date} renderItem={({ item, index }) => <DayRow day={item} today={today} target={d.kcalTarget} first={index === 0} last={index === days.length - 1} onPick={onPick} />}
        ListHeaderComponent={header} contentContainerStyle={s.list} style={{ flex: 1 }} removeClippedSubviews windowSize={5} />
      {editing ? (
        <EditSheet visible it={asItem(editing)} slot={slot} onSlotChange={setSlot} onClose={() => { setEditing(null); setEditError(''); }} error={editError}
          onDelete={() => { st.deleteEntry(editing.id); setEditing(null); }}
          onSave={(n) => {
            // explicit user edit: new snapshot, stamped with the current table version
            const why = st.updateEntry({ ...editing, slot, qty: n.quantity, unit: n.unit, oil_level: n.oil_level, dish_id: editing.dish_id ? n.dish_id : null,
              kcal: n.kcal, protein_g: n.protein_g, carbs_g: n.carbs_g, fat_g: n.fat_g, dish_table_version: editing.dish_id ? DISH_TABLE_VERSION : editing.dish_table_version });
            if (why) { setEditError(why); return; } // refused: the sheet stays open with the reason
            setEditError(''); setEditing(null);
          }} />
      ) : null}
    </SafeAreaView></View>
  );
}
const useStyles = makeStyles((t) => ({
  screen: { flex: 1 },
  list: { padding: t.space.screen, paddingBottom: t.sizes.nav + t.space.xxl },
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 6, columnGap: '1.5%' as never },
  cell: { width: '12.9%' as never, aspectRatio: 1.1, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  dayRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 56, paddingVertical: 8 },
  sep: { borderTopWidth: 1, borderTopColor: t.c.lineSoft },
  dayCard: { backgroundColor: t.c.card, paddingHorizontal: t.space.cardH, borderLeftWidth: 1, borderRightWidth: 1, borderColor: t.c.cardLine },
  top: { borderTopWidth: 1, borderTopLeftRadius: t.radius.card, borderTopRightRadius: t.radius.card, paddingTop: 4 },
  bottom: { borderBottomWidth: 1, borderBottomLeftRadius: t.radius.card, borderBottomRightRadius: t.radius.card, paddingBottom: 4 },
  entry: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 40, paddingLeft: 8 },
}));
