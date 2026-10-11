import { memo, useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Glows } from '@/components/Gradient';
import { EditSheet } from '@/components/ItemEditor';
import { Card, Row, T } from '@/components/ui';
import { addDays, dayTotals, FoodEntry, localDate, Slot } from '@/lib/domain';
import { SLOT_LABEL } from '@/lib/labels';
import { useStore } from '@/lib/store';
import { useDay } from '@/lib/useDay';
import { DISH_TABLE_VERSION, Item, parser } from '@/parser';
import { makeStyles, useTheme } from '@/theme';

/** Saved entry -> editable Item view. Numbers come from the snapshot, not the table. */
function asItem(e: FoodEntry): Item {
  return { dish_id: e.dish_id ?? '', name: e.custom_name || parser.dishById(e.dish_id ?? '')?.name || 'item', matched_text: e.raw_text,
    quantity: e.qty, unit: e.unit, grams: 0, oil_level: e.oil_level, kcal: e.kcal, protein_g: e.protein_g,
    source: 'table', data_source: e.source === 'table' ? (parser.dishById(e.dish_id ?? '')?.source ?? 'estimate') : e.source, source_note: e.source_note,
    fuzzy: false, ai_estimate: e.source === 'ai' || e.source === 'custom', carbs_g: e.carbs_g ?? 0, fat_g: e.fat_g ?? 0, needs_confirmation: false };
}

type Day = { date: string; kcal: number; protein: number; entries: FoodEntry[] };
const DayRow = memo(function DayRow({ day, onPick }: { day: Day; onPick: (e: FoodEntry) => void }) {
  return (
    <Card>
      <Row style={{ justifyContent: 'space-between' }}><T v="bodyStrong">{day.date}</T><T tone="muted">{day.kcal} kcal · {day.protein} g</T></Row>
      {day.entries.map((e) => (
        <Pressable key={e.id} onPress={() => onPick(e)} accessibilityRole="button" accessibilityLabel={`Edit ${e.custom_name || e.dish_id}`} style={{ minHeight: 40, justifyContent: 'center' }}>
          <Row style={{ justifyContent: 'space-between' }}>
            <T tone="text2" style={{ flex: 1 }}>{SLOT_LABEL[e.slot]} · {e.custom_name || e.dish_id?.replaceAll('_', ' ')} · {e.qty} {e.unit}</T><T>{e.kcal.best} ✎</T>
          </Row>
        </Pressable>
      ))}
    </Card>
  );
});

export default function Progress() {
  const st = useStore(); const d = useDay(); const s = useStyles(); const t = useTheme();
  const [editing, setEditing] = useState<FoodEntry | null>(null);
  const [slot, setSlot] = useState<Slot>('lunch');
  const days = useMemo<Day[]>(() => {
    const by = new Map<string, FoodEntry[]>();
    for (const e of st.entries) if (!e.deleted_at) by.set(e.local_date, [...(by.get(e.local_date) ?? []), e]);
    return [...by.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([date, entries]) => ({ date, entries, ...dayTotals(entries) }));
  }, [st.entries]);
  const today = localDate();
  const cal = useMemo(() => Array.from({ length: 28 }, (_, i) => addDays(today, i - 27)), [today]);
  const onPick = useCallback((e: FoodEntry) => { setSlot(e.slot); setEditing(e); }, []);
  const header = (
    <View style={{ gap: 10 }}>
      <T v="title">Progress</T>
      <Card tone="tintGold">
        <Row style={{ justifyContent: 'space-between' }}><T v="displayXl" tone="gold">{d.streak.current}</T><T tone="gold">day streak · best {d.streak.best}</T></Row>
        <T v="caption" tone="muted">1 freeze a week, used automatically on a missed day.</T>
      </Card>
      <Card>
        <View style={s.grid}>
          {cal.map((day) => {
            const logged = d.loggedDates.has(day), frozen = d.streak.frozenDays.includes(day);
            return (
              <View key={day} style={[s.cell, { backgroundColor: logged ? t.c.em : frozen ? t.c.tint : t.c.track }]}
                accessibilityLabel={`${day}: ${logged ? 'logged' : frozen ? 'freeze used' : 'not logged'}`}>
                <T v="micro" tone={logged ? 'onGrad' : frozen ? 'freeze' : 'muted'}>{frozen ? '❄' : day.slice(8)}</T>
              </View>
            );
          })}
        </View>
        <T v="caption" tone="muted">{d.loggedDates.size} days logged in total</T>
      </Card>
    </View>
  );
  return (
    <View style={{ flex: 1 }}><Glows /><SafeAreaView edges={['top']} style={s.screen}>
      <FlatList data={days} keyExtractor={(x) => x.date} renderItem={({ item }) => <DayRow day={item} onPick={onPick} />}
        ListHeaderComponent={header} contentContainerStyle={s.list} ItemSeparatorComponent={() => <View style={{ height: 10 }} />} removeClippedSubviews windowSize={5} />
      {editing ? (
        <EditSheet visible it={asItem(editing)} slot={slot} onSlotChange={setSlot} onClose={() => setEditing(null)}
          onDelete={() => { st.deleteEntry(editing.id); setEditing(null); }}
          onSave={(n) => {
            // explicit user edit: new snapshot, stamped with the current table version
            st.updateEntry({ ...editing, slot, qty: n.quantity, unit: n.unit, oil_level: n.oil_level, dish_id: editing.dish_id ? n.dish_id : null,
              kcal: n.kcal, protein_g: n.protein_g, carbs_g: n.carbs_g, fat_g: n.fat_g, dish_table_version: editing.dish_id ? DISH_TABLE_VERSION : editing.dish_table_version });
            setEditing(null);
          }} />
      ) : null}
    </SafeAreaView></View>
  );
}
const useStyles = makeStyles((t) => ({
  screen: { flex: 1 },
  list: { padding: t.space.screen, paddingBottom: t.sizes.nav + t.space.xxl },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  cell: { width: 38, height: 34, borderRadius: t.radius.chip, alignItems: 'center', justifyContent: 'center' },
}));
