// "Change" in the habit toast and "Log a different amount ›" on detail (Q9: count and sets habits only): log part of the
// target for that day, "5 of 8 glasses" / "2 of 3 sets". The stepper runs 0 … the full target (− off at 0, + off at the
// target); the full target marks it done, 0 clears the day. Partial amounts are text, never a fill (§10.4).
import { useEffect, useState } from 'react';
import { Modal, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { T } from '@/components/ui';
import { useHabits } from '@/lib/habits';
import { useTheme } from '@/theme';
import { Stepper } from '../plans/parts';
import { fullValue, logOf, snapOf } from './model';

export function AmountSheet({ habitId, date, today, onClose }: { habitId: string | null; date: string; today: string; onClose: () => void }) {
  const t = useTheme(); const ins = useSafeAreaInsets(); const hb = useHabits();
  const h = habitId ? hb.habitById(habitId) : null;
  const log = h ? logOf(hb.state, h.id, date) : null;
  const snap = log?.target_snapshot ?? (h ? snapOf(h) : null);
  const full = snap ? fullValue(snap) ?? 0 : 0;
  const [v, setV] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setV(log?.done ? full : log?.value ?? 0); setErr(null); }, [habitId, date]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!h || !snap || snap.kind === 'done') return null;
  const unit = snap.kind === 'count' ? snap.unit ?? '' : 'sets';
  const save = () => { const e = hb.setAmount(h.id, date, v, today); if (e) setErr(e); else onClose(); };
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: t.c.scrim }} onPress={onClose} accessibilityLabel="Close" />
      <View style={{ backgroundColor: t.c.sheet, borderTopLeftRadius: t.radius.sheet, borderTopRightRadius: t.radius.sheet, padding: 20, paddingBottom: 24 + ins.bottom, gap: 14 }} testID="amount-sheet">
        <T v="title" accessibilityRole="header" style={{ fontSize: 22 }}>Log a different amount</T>
        <T tone="text2" style={{ fontSize: 15 }}>{h.name}</T>
        <Stepper label={snap.kind === 'count' ? `Amount (${unit})` : 'Sets done'} value={v} text={`${v} of ${full} ${unit}`.trim()} min={0} max={full}
          onStep={(d) => { setErr(null); setV((x) => x + d); }} />
        {err ? <T style={{ color: t.c.warn, fontSize: 14 }}>{err}</T> : null}
        <Pressable onPress={save} accessibilityRole="button" accessibilityLabel="Save amount"
          style={({ pressed }) => ({ minHeight: 56, borderRadius: 16, backgroundColor: t.c.accentFill, borderWidth: 1.5, borderColor: t.c.honeyEdge, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.85 : 1 })}>
          <T v="button" style={{ color: t.c.onAccent, fontSize: 17 }}>Save</T>
        </Pressable>
      </View>
    </Modal>
  );
}
