// Food tab: the day timeline (build-plan item 6, spec §4, frames tl-main / tl-empty, Q10, Q12). One day by eaten-at time
// from 4 AM (dayOf), entries within 45 minutes in one display-only block with its kcal. Tap a block to open its items;
// tap an item to update it in the v4 item sheet (time chip); ✕ removes it with Undo; the block's time moves all its items.
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { PendingRow } from '@/components/PendingRow';
import { ReviewLink } from '@/components/ReviewLink';
import { ServerNoteRow } from '@/components/ServerNoteRow';
import { SyncFailedRow } from '@/components/SyncFailedRow';
import { PICK_TYPE_COPY, VariantPickSheet } from '@/components/VariantPickSheet';
import { T } from '@/components/ui';
import { addDays, countedNums, dayOf, entryLabel, entryRefusal, FoodEntry } from '@/lib/domain';
import { useStore } from '@/lib/store';
import { useDay } from '@/lib/useDay';
import { foodCard } from '@/features/home/model';
import { ItemSheet } from '@/features/logfood/ItemSheet';
import { chipLabel, clock, dateLong, pickTime, TimePick, timeReason, TrayItem } from '@/features/logfood/model';
import { TimeSheet } from '@/features/logfood/TimeSheet';
import { useTheme } from '@/theme';
import { amountText, Block, blocks, entryFromEdit, moveBlock, timeOf, trayFromEntry } from './model';

const n = (x: number) => Math.round(x).toLocaleString('en-IN');
const AMOUNT_UNKNOWN = 'amount unknown';

export function TimelineScreen({ now = () => new Date() }: { now?: () => Date }) {
  const t = useTheme(); const st = useStore(); const router = useRouter();
  const today = dayOf(now());
  const [date, setDate] = useState(today);
  const d = useDay(date);
  const food = foodCard(d.entries, d.kcalTarget, d.proteinTarget);
  const list = useMemo(() => blocks(d.entries), [d.entries]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [edit, setEdit] = useState<{ id: string; tray: TrayItem; time: TimePick; reason?: string | null } | null>(null);
  const [timeFor, setTimeFor] = useState<'item' | Block | null>(null);
  const [moveReason, setMoveReason] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const pickRow = picking ? st.entries.find((e) => e.id === picking && e.sync_error === 'variant_required') ?? null : null;
  const notes = d.entries.filter((e) => e.server_note && !e.needs_review && !e.deleted_at);
  const dayLabel = `${dateLong(date)}${date === today ? ' · Today' : date === addDays(today, -1) ? ' · Yesterday' : ''}`;
  const rowTitle = (e: FoodEntry) => `${clock(new Date(timeOf(e)))} · ${entryLabel(e)}`;

  const openEdit = (e: FoodEntry) => setEdit({ id: e.id, tray: trayFromEntry(e), time: { kind: 'at', iso: timeOf(e) } });
  const saveEdit = (tray: TrayItem) => {
    if (!edit) return;
    const old = st.entries.find((x) => x.id === edit.id);
    if (!old) { setEdit(null); return; }
    const at = pickTime(edit.time, now());
    const why = timeReason(at, now());
    if (why) { setEdit({ ...edit, tray, reason: why }); return; }
    const r = entryFromEdit(old, tray, at, now());
    if (r.reason) { setEdit({ ...edit, tray, reason: r.reason }); return; }
    if (r.entry) { const no = st.updateEntry(r.entry); if (no) { setEdit({ ...edit, tray, reason: no }); return; } }
    setEdit(null);
  };
  const remove = (e: FoodEntry) => {
    st.deleteEntry(e.id);
    st.showUndo(`Removed ${entryLabel(e)}`, () => st.restoreEntry(e.id));
  };
  /** §4: all-or-nothing; every item is checked first, then each goes through the edit path. */
  const move = (b: Block, p: TimePick) => {
    const to = pickTime(p, now());
    const moves = moveBlock(b, to);
    const edits: FoodEntry[] = [];
    for (const m of moves) {
      const old = st.entries.find((x) => x.id === m.id);
      if (!old) continue;
      const why = timeReason(m.at, now());
      if (why) { setMoveReason(why); return; }
      const r = entryFromEdit(old, trayFromEntry(old), m.at, now());
      const no = r.reason ?? (r.entry ? entryRefusal(r.entry) : null);
      if (no) { setMoveReason(no); return; }
      if (r.entry) edits.push(r.entry);
    }
    setMoveReason(null);
    for (const e of edits) st.updateEntry(e);
    setTimeFor(null);
    if (edits.length) setDate(dayOf(to));
  };

  const card = { backgroundColor: t.c.card, borderRadius: t.radius.card, borderWidth: 1, borderColor: t.c.lineSoft } as const;
  const blockView = (b: Block) => {
    const isOpen = !!open[b.key];
    const time = clock(new Date(b.start));
    const names = b.entries.map((e) => `${entryLabel(e)}, ${amountText(e)}`).join('; ');
    return (
      <View key={b.key} style={[card, { paddingVertical: 14, paddingHorizontal: 18 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
          <Pressable onPress={() => { setMoveReason(null); setTimeFor(b); }} accessibilityRole="button" accessibilityLabel={`${time}. Change time for ${b.entries.length} ${b.entries.length === 1 ? 'item' : 'items'}`}
            style={{ width: 96, minHeight: 48, marginTop: -12, justifyContent: 'center' }}>
            <T v="bodyStrong" style={{ fontSize: 16 }}>{time}</T>
          </Pressable>
          <Pressable onPress={() => setOpen({ ...open, [b.key]: !isOpen })} accessibilityRole="button" accessibilityState={{ expanded: isOpen }}
            accessibilityLabel={`${names}. ${n(b.kcal)} calories. ${isOpen ? 'Close' : 'Open'}`} style={{ flex: 1, flexDirection: 'row', minHeight: 24 }}>
            <View style={{ flex: 1, gap: 6 }}>
              {isOpen ? null : b.entries.map((e) => (
                <T key={e.id} numberOfLines={1} style={{ fontSize: 16 }}>{entryLabel(e)} <T tone="muted" style={{ fontSize: 15 }}>{amountText(e)}</T></T>
              ))}
            </View>
            <T v="bodyStrong" style={{ fontSize: 17, marginLeft: 8 }}>{n(b.kcal)}</T>
          </Pressable>
        </View>
        {isOpen ? (
          <View style={{ marginTop: 4 }}>
            {b.entries.map((e, i) => (
              <View key={e.id} style={{ flexDirection: 'row', alignItems: 'center', minHeight: 52, borderTopWidth: i ? 1 : 0, borderTopColor: t.c.lineSoft }}>
                <Pressable onPress={() => openEdit(e)} accessibilityRole="button" accessibilityLabel={`${entryLabel(e)}, ${amountText(e)}, ${n(countedNums(e).kcal)} calories. Edit`}
                  style={{ flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 52 }}>
                  <T style={{ flex: 1, fontSize: 16 }} numberOfLines={1}>{entryLabel(e)} <T tone="muted" style={{ fontSize: 15 }}>{amountText(e)}</T></T>
                  <T tone="text2" style={{ fontSize: 15 }}>{n(countedNums(e).kcal)}</T>
                </Pressable>
                <Pressable onPress={() => remove(e)} accessibilityRole="button" accessibilityLabel={`Remove ${entryLabel(e)}`}
                  style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center', marginRight: -12 }}>
                  <Icon name="x" color={t.c.text2} size={18} strokeWidth={2.2} />
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}
      </View>
    );
  };

  const empty = !d.entries.length && !d.pending.length && !d.reviewCount && !d.syncFailed.length;
  return (
    <View style={{ flex: 1, backgroundColor: t.c.bg }}>
      <SafeAreaView edges={['top']} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 32, gap: 14 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 64, marginTop: 4 }}>
            <T v="title" accessibilityRole="header" style={{ fontSize: 28 }}>Food</T>
            <Pressable onPress={() => router.push('/log-food')} accessibilityRole="button" accessibilityLabel="Log food"
              style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48, paddingHorizontal: 4 }}>
              <Icon name="plus" color={t.c.text} size={18} strokeWidth={2.2} />
              <T v="bodyStrong" style={{ fontSize: 17 }}>Log food</T>
            </Pressable>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Pressable onPress={() => setDate(addDays(date, -1))} accessibilityRole="button" accessibilityLabel="Previous day"
              style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center', marginLeft: -12 }}>
              <Icon name="back" color={t.c.text} size={20} strokeWidth={2.2} />
            </Pressable>
            <T v="bodyStrong" style={{ fontSize: 17 }} accessibilityLiveRegion="polite">{dayLabel}</T>
            <Pressable onPress={() => date < today && setDate(addDays(date, 1))} disabled={date >= today} accessibilityRole="button" accessibilityLabel="Next day"
              accessibilityState={{ disabled: date >= today }} style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center', marginRight: -12, opacity: date >= today ? 0.3 : 1 }}>
              <Icon name="chevron" color={t.c.text} size={20} strokeWidth={2.2} />
            </Pressable>
          </View>
          <View accessible accessibilityLabel={`${n(food.eaten)} of ${n(food.kcalTarget)} calories. ${food.isOver ? `${n(food.over)} over` : `${n(food.left)} left`}`}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, flexShrink: 1 }}>
                <T v="display" testID="tl-eaten" style={{ fontSize: 44, lineHeight: 50, letterSpacing: -1.2 }}>{n(food.eaten)}</T>
                <T v="bodyStrong" tone="text2" style={{ fontSize: 17, marginBottom: 8 }}>of {n(food.kcalTarget)} kcal</T>
              </View>
              <T v="bodyStrong" style={{ fontSize: 17, marginBottom: 6, color: food.isOver ? t.c.over : t.c.text2 }}>{food.isOver ? `${n(food.over)} over` : `${n(food.left)} left`}</T>
            </View>
            <View style={{ height: 10, borderRadius: 5, backgroundColor: t.c.track, overflow: 'hidden', marginTop: 10 }}>
              <View style={{ width: `${Math.round(food.kcalPct * 100)}%`, height: '100%', borderRadius: 5, backgroundColor: food.isOver ? t.c.over : t.c.food }} />
            </View>
          </View>
          {d.reviewCount ? <ReviewLink date={d.date} n={d.reviewCount} /> : null}
          {d.syncFailed.map((e) => (
            <SyncFailedRow key={`sync-${e.id}`} title={`${rowTitle(e)}${e.deleted_at ? ' (deleted)' : ''}`}
              kcal={e.deleted_at && !e.delete_failed ? undefined : countedNums(e).kcal} notCounted={(!e.deleted_at || !!e.delete_failed) && !!e.server_failed && !e.server_counts}
              retrying={!!e.sync_retrying} reason={e.sync_reason} line={e.sync_error === 'variant_required' && !e.deleted_at ? PICK_TYPE_COPY : undefined}
              onRetry={() => (e.sync_error === 'variant_required' && !e.deleted_at ? setPicking(e.id) : st.retrySync(e.id))} />
          ))}
          {notes.map((e) => (
            <ServerNoteRow key={`note-${e.id}`} title={`${rowTitle(e)}${e.amount_unknown ? ` · ${AMOUNT_UNKNOWN}` : ''}`}
              kcal={e.amount_unknown && !e.server_counts ? undefined : countedNums(e).kcal} note={e.server_note!} onDismiss={() => st.clearServerNote(e.id)} />
          ))}
          {d.pending.map((f) => <PendingRow key={f.id} label={f.span} state={d.offline ? 'offline' : 'estimating'} />)}
          {list.map(blockView)}
          {empty ? (
            <View style={[card, { alignItems: 'center', paddingVertical: 32, paddingHorizontal: 20 }]}>
              <View style={{ width: 72, height: 72, borderRadius: 20, backgroundColor: t.c.sheetTile, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="food" color={t.c.food} size={30} strokeWidth={1.9} />
              </View>
              <T v="bodyStrong" style={{ fontSize: 22, marginTop: 20 }}>Nothing logged yet</T>
              <T tone="text2" style={{ marginTop: 6 }}>Your day resets at 4 AM.</T>
              <Pressable onPress={() => router.push('/log-food')} accessibilityRole="button" accessibilityLabel="Log food"
                style={{ marginTop: 22, flexDirection: 'row', alignItems: 'center', gap: 8, height: 56, paddingHorizontal: 26, borderRadius: t.radius.button, borderWidth: 1.5, borderColor: t.c.stateLine }}>
                <Icon name="plus" color={t.c.text} size={18} strokeWidth={2.2} />
                <T v="bodyStrong" style={{ fontSize: 17 }}>Log food</T>
              </Pressable>
            </View>
          ) : null}
        </ScrollView>
      </SafeAreaView>
      {edit ? (
        <ItemSheet key={edit.id} item={edit.tray} editing onClose={() => setEdit(null)} onDone={saveEdit} reason={edit.reason}
          time={{ label: chipLabel(edit.time, now()), onPress: () => setTimeFor('item') }} />
      ) : null}
      <TimeSheet visible={timeFor === 'item' && !!edit} value={edit?.time ?? { kind: 'now' }} now={now} onClose={() => setTimeFor(null)}
        onPick={(p) => { if (edit) setEdit({ ...edit, time: p, reason: null }); setTimeFor(null); }} />
      {timeFor && timeFor !== 'item' ? (
        <TimeSheet visible value={{ kind: 'at', iso: timeFor.start }} now={now} onClose={() => { setTimeFor(null); setMoveReason(null); }} onPick={(p) => move(timeFor, p)}
          title={timeFor.entries.length > 1 ? 'Move this meal' : undefined}
          note={moveReason ?? (timeFor.entries.length > 1 ? `Moves all ${timeFor.entries.length} items together.` : undefined)} />
      ) : null}
      <VariantPickSheet entry={pickRow} onPick={(dish) => st.pickVariant(pickRow!.id, dish)} onClose={() => setPicking(null)} />
    </View>
  );
}
