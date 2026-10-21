// §4 time chip: Now / 30 min ago / 1 hr ago / Earlier ▾. Only Earlier opens the wheel (day, hour, minute, AM/PM, "Set 8:45 PM").
// A future time or one more than 7 days back can't be set (the reason shows, Set is disabled).
import { useState } from 'react';
import { Modal, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { T } from '@/components/ui';
import { useTheme } from '@/theme';
import { clock, dateLong, dayStartLine, pickTime, TimePick, timeReason, wheelDays, wheelOf, wheelTime } from './model';

const HOURS = Array.from({ length: 12 }, (_, i) => i + 1);
const MINS = Array.from({ length: 12 }, (_, i) => i * 5);

export function TimeSheet({ visible, value, now, onClose, onPick }: { visible: boolean; value: TimePick; now: () => Date; onClose: () => void; onPick: (p: TimePick) => void }) {
  const t = useTheme(); const ins = useSafeAreaInsets();
  const [wheel, setWheel] = useState<ReturnType<typeof wheelOf> | null>(null);
  if (!visible) return null;
  const n = now();
  const close = () => { setWheel(null); onClose(); };
  const pick = (p: TimePick) => { setWheel(null); onPick(p); };
  const sel = (p: TimePick) => (p.kind === value.kind && (p.kind !== 'ago' || (value.kind === 'ago' && value.min === p.min)));
  const rows: { p: TimePick | null; label: string; right: string }[] = [
    { p: { kind: 'now' }, label: 'Now', right: clock(n) },
    { p: { kind: 'ago', min: 30 }, label: '30 min ago', right: clock(pickTime({ kind: 'ago', min: 30 }, n)) },
    { p: { kind: 'ago', min: 60 }, label: '1 hr ago', right: clock(pickTime({ kind: 'ago', min: 60 }, n)) },
    { p: null, label: 'Earlier ▾', right: value.kind === 'at' ? clock(pickTime(value, n)) : 'Pick a time' },
  ];
  const sheet = { backgroundColor: t.c.sheet, borderTopLeftRadius: t.radius.sheet, borderTopRightRadius: t.radius.sheet, paddingHorizontal: 24, paddingTop: 10, paddingBottom: 20 + ins.bottom,
    ...(t.dark ? { borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)' } : {}) } as const;
  const handle = <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: t.c.handle, alignSelf: 'center', marginBottom: 14 }} />;

  let body;
  if (!wheel) {
    body = (
      <>
        <T v="title" accessibilityRole="header" style={{ fontSize: 22 }}>When did you eat this?</T>
        <T tone="muted" style={{ marginTop: 2, marginBottom: 8 }}>Saved as Now unless you change it.</T>
        {rows.map((r) => {
          const on = r.p ? sel(r.p) : value.kind === 'at';
          return (
            <Pressable key={r.label} onPress={() => (r.p ? pick(r.p) : setWheel(wheelOf(value.kind === 'at' ? pickTime(value, n) : n)))}
              accessibilityRole="button" accessibilityState={{ selected: on }} accessibilityLabel={`${r.label.replace(' ▾', '')}, ${r.right}`}
              style={{ flexDirection: 'row', alignItems: 'center', minHeight: 64, borderTopWidth: 1, borderTopColor: t.c.sheetLine }}>
              <T v="bodyStrong" style={{ fontSize: 17, flex: 1 }}>{r.label}</T>
              <T tone="muted" style={{ fontSize: 15, marginRight: on && r.p ? 10 : 0 }}>{r.right}</T>
              {on && r.p ? <T v="bodyStrong" style={{ fontSize: 18 }}>✓</T> : null}
            </Pressable>
          );
        })}
      </>
    );
  } else {
    const days = wheelDays(n);
    const at = wheelTime(wheel.date, wheel.h12, wheel.minute, wheel.pm);
    const why = timeReason(at, n);
    const di = days.findIndex((d) => d.date === wheel.date);
    const col = <V,>(label: string, list: V[], idx: number, show: (v: V) => string, set: (v: V) => void, flex = 1, cyclic = false) => {
      const at = (j: number) => (cyclic ? list[(j + list.length) % list.length] : list[j]);
      return (
      <View accessibilityRole="adjustable" accessibilityLabel={`${label}, ${show(list[idx])}`} style={{ flex, alignItems: 'center' }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => { const v = at(idx + (e.nativeEvent.actionName === 'increment' ? 1 : -1)); if (v !== undefined) set(v); }}>
        {[-1, 0, 1].map((o) => {
          const v = at(idx + o);
          return (
            <Pressable key={o} disabled={v === undefined || o === 0} onPress={() => v !== undefined && set(v)} importantForAccessibility="no"
              style={{ height: 52, justifyContent: 'center', alignSelf: 'stretch', alignItems: 'center' }}>
              <T style={{ fontSize: o === 0 ? 22 : 19, fontFamily: o === 0 ? t.type.title.fontFamily : t.type.body.fontFamily, color: o === 0 ? t.c.text : t.c.muted }}>
                {v === undefined ? ' ' : show(v)}
              </T>
            </Pressable>
          );
        })}
      </View>
      );
    };
    body = (
      <>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <T v="title" accessibilityRole="header" style={{ fontSize: 20 }}>Earlier</T>
          <T tone="text2">{dateLong(wheel.date)}</T>
        </View>
        <View style={{ marginTop: 10 }}>
          <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, top: 52, height: 52, borderTopWidth: 1, borderBottomWidth: 1, borderColor: t.c.text2 }} />
          <View style={{ flexDirection: 'row' }}>
            {col('Day', days, di, (d) => d.label, (d) => setWheel({ ...wheel, date: d.date }), 1.6)}
            {col('Hour', HOURS, HOURS.indexOf(wheel.h12), String, (h) => setWheel({ ...wheel, h12: h }), 1, true)}
            {col('Minute', MINS, MINS.indexOf(wheel.minute), (m) => String(m).padStart(2, '0'), (m) => setWheel({ ...wheel, minute: m }), 1, true)}
            {col('AM or PM', [false, true], wheel.pm ? 1 : 0, (p) => (p ? 'PM' : 'AM'), (p) => setWheel({ ...wheel, pm: p }))}
          </View>
        </View>
        <T tone="text2" style={{ marginTop: 14, fontSize: 14 }}>{dayStartLine()}</T>
        {why ? <T style={{ color: t.c.warn, marginTop: 6 }} accessibilityLiveRegion="polite">{why}</T> : null}
        <Pressable onPress={() => pick({ kind: 'at', iso: at.toISOString() })} disabled={!!why} accessibilityRole="button" accessibilityState={{ disabled: !!why }}
          accessibilityLabel={`Set ${clock(at)}`}
          style={{ marginTop: 14, height: 56, borderRadius: t.radius.button, alignItems: 'center', justifyContent: 'center',
            backgroundColor: why ? t.c.sheetTile : t.c.accentFill, borderWidth: why || t.dark ? 0 : 1.5, borderColor: t.c.honeyEdge }}>
          <T v="bodyStrong" style={{ fontSize: 17, color: why ? t.c.muted : t.c.onAccent }}>Set {clock(at)}</T>
        </Pressable>
      </>
    );
  }
  return (
    <Modal visible transparent animationType="slide" onRequestClose={close}>
      <Pressable style={{ flex: 1, backgroundColor: t.c.scrim }} onPress={close} accessibilityLabel="Close" />
      <View accessibilityViewIsModal style={sheet}>{handle}{body}</View>
    </Modal>
  );
}
