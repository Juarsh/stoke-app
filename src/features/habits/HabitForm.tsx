// Create / Edit habit (build-plan item 14; spec §8, §10.2; habits-v2/hb1-create; CEO Q17–Q21). ✕ "New habit" (or "Edit
// habit"). Name; Short name right under it (Q18) with a live Home preview and a Large text (1.3×) preview — it follows the
// name (auto-derive) until edited; a weak derive is highlighted for editing; a word too wide for the 74dp slot shows "Too
// long for Home. Try a shorter name." and Save waits; clashes show "Already used, pick another". Type: Yes / no · Count ·
// Sets; Target steppers with a unit (Count) or sets × reps; Days: Every day · Weekdays · Pick days. Honey Save habit.
// Steps are never offered. Exercise linking is cut from v1 (CEO, M3). Nothing is clamped: Save refuses with the reason.
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Modal, Pressable, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { T } from '@/components/ui';
import { useHabits } from '@/lib/habits';
import { useLogDay } from '@/lib/useLogDay';
import { useTheme } from '@/theme';
import { Header, Stepper } from '../plans/parts';
import { HabitItem } from './HabitIcon';
import { blankDraft, DAY_NAMES, deriveShort, Draft, draftErrors, draftOf, HabitKind, LIMITS, Schedule, UNITS } from './model';

export function HabitForm({ id: idProp }: { id?: string }) {
  const params = useLocalSearchParams<{ id?: string }>();
  const id = idProp ?? (params.id ? String(params.id) : undefined);
  const t = useTheme(); const router = useRouter(); const ins = useSafeAreaInsets(); const hb = useHabits(); const today = useLogDay();
  const editing = id ? hb.habitById(id) : null;
  const [d, setD] = useState<Draft>(() => (editing ? draftOf(editing) : blankDraft()));
  const [weak, setWeak] = useState(false);
  const [tried, setTried] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [units, setUnits] = useState(false);
  const others = hb.state.habits.filter((h) => h.id !== id);
  const errs = draftErrors(d, others);
  const set = (p: Partial<Draft>) => { setSaveErr(null); setD((x) => ({ ...x, ...p })); };
  const onName = (name: string) => {
    const g = deriveShort(name);
    if (d.short_name_auto) { setWeak(g.weak); set({ name, short_name: g.short, icon: g.icon }); } else set({ name, icon: g.icon ?? d.icon });
  };
  const onShort = (short_name: string) => { setWeak(false); set({ short_name, short_name_auto: false }); };
  const save = () => {
    setTried(true);
    const r = editing ? hb.update(editing.id, d) : hb.create(d, today);
    if (typeof r === 'string') { setSaveErr(r); return; }
    router.back();
  };
  // the short-name problems show live (the fit check is the point of the preview); others after the first Save
  const shortErr = d.short_name.trim() ? errs.short : tried ? errs.short : undefined;
  const label = (s: string) => <T v="bodyStrong" style={{ fontSize: 15, marginTop: 14, marginBottom: 6 }}>{s}</T>;
  const field = (bad: boolean, hi = false) => ({ minHeight: 56, borderRadius: 14, borderWidth: hi ? 2 : 1.5, borderColor: bad ? t.c.warn : hi ? t.c.honeyEdge : t.c.cardLine,
    backgroundColor: t.c.card, paddingHorizontal: 16, fontSize: 18, color: t.c.text } as const);
  const errLine = (e?: string) => (e ? <T style={{ color: t.c.warn, fontSize: 14, marginTop: 6 }} accessibilityLiveRegion="polite">{e}</T> : null);
  function Seg<V extends string>({ value, options, onPick, a11y }: { value: V; options: [V, string][]; onPick: (v: V) => void; a11y: string }) {
    return (
      <View style={{ flexDirection: 'row', backgroundColor: t.c.card2, borderRadius: 16, padding: 4, gap: 4 }} accessibilityRole="radiogroup" accessibilityLabel={a11y}>
        {options.map(([v, l]) => {
          const on = value === v;
          return (
            <Pressable key={v} onPress={() => onPick(v)} accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={l}
              style={{ flex: 1, minHeight: 52, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? t.c.card : 'transparent', ...(on ? t.elev.e1 : {}) }}>
              <T v={on ? 'bodyStrong' : 'body'} style={{ fontSize: 16 }}>{l}</T>
            </Pressable>
          );
        })}
      </View>
    );
  }
  return (
    <View style={{ flex: 1, backgroundColor: t.c.bg }} testID="habit-form">
      <Header title={editing ? 'Edit habit' : 'New habit'} close />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
        {label('Name')}
        <TextInput value={d.name} onChangeText={onName} accessibilityLabel="Name" placeholder="Water 8 glasses" placeholderTextColor={t.c.muted} maxLength={LIMITS.name + 10} style={field(!!(tried && errs.name))} />
        {tried ? errLine(errs.name) : null}
        {label('Short name')}
        <TextInput value={d.short_name} onChangeText={onShort} accessibilityLabel="Short name, shown on Home" placeholder="Water" placeholderTextColor={t.c.muted}
          style={[field(!!shortErr, weak), { minWidth: 0 }]} />
        <T tone="text2" style={{ fontSize: 14, marginTop: 6 }}>{weak ? 'Pick a short name, like Gran.' : 'Shown under the icon on Home.'}</T>
        {errLine(shortErr)}
        <View style={{ flexDirection: 'row', gap: 16, marginTop: 10, alignItems: 'flex-start' }} testID="short-preview">
          {([['Home', 1], ['Large text', 1.3]] as const).map(([l, sc]) => (
            <View key={l} style={{ alignItems: 'center', gap: 6, backgroundColor: t.c.card, borderRadius: 14, borderWidth: 1, borderColor: t.c.lineSoft, paddingVertical: 10, paddingHorizontal: 12 }}
              accessible accessibilityLabel={`${l} preview: ${d.short_name || 'empty'}`}>
              <HabitItem short={d.short_name} name={d.name} icon={d.icon} done={false} scale={sc} twoLines={sc > 1} />
              <T tone="muted" style={{ fontSize: 13 }}>{l}</T>
            </View>
          ))}
        </View>
        {label('Type')}
        <Seg<HabitKind> value={d.kind} a11y="Type" options={[['done', 'Yes / no'], ['count', 'Count'], ['sets', 'Sets']]} onPick={(kind) => set({ kind })} />
        {d.kind !== 'done' ? (
          <>
            {label('Target')}
            {d.kind === 'count' ? (
              <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
                <Stepper label={`Target (${d.unit})`} value={d.target_value} text={`${d.target_value} ${d.unit}`} min={LIMITS.count[0]} max={LIMITS.count[1]} onStep={(x) => set({ target_value: d.target_value + x })} />
                <Pressable onPress={() => setUnits(true)} accessibilityRole="button" accessibilityLabel={`Unit, ${d.unit}. Change unit`} style={{ minHeight: 48, justifyContent: 'center', alignItems: 'flex-end' }}>
                  <T tone="text2" style={{ fontSize: 14 }}>Unit</T>
                  <T v="bodyStrong" style={{ fontSize: 15 }}>{`${d.unit} ›`}</T>
                </Pressable>
              </View>
            ) : (
              <View style={{ flexDirection: 'row', gap: 16, flexWrap: 'wrap' }}>
                <Stepper label="Sets" value={d.target_sets} min={LIMITS.sets[0]} max={LIMITS.sets[1]} onStep={(x) => set({ target_sets: d.target_sets + x })} />
                <Stepper label="Reps" value={d.target_reps} min={LIMITS.reps[0]} max={LIMITS.reps[1]} onStep={(x) => set({ target_reps: d.target_reps + x })} />
              </View>
            )}
            {errLine(errs.target)}
          </>
        ) : null}
        {label('Days')}
        <Seg<Schedule> value={d.schedule} a11y="Days" options={[['daily', 'Every day'], ['weekdays', 'Weekdays'], ['days', 'Pick days']]}
          onPick={(schedule) => set({ schedule, weekdays: schedule === 'days' && d.schedule !== 'days' ? (d.schedule === 'weekdays' ? 31 : 127) : d.weekdays })} />
        {d.schedule === 'days' ? (
          <View style={{ flexDirection: 'row', gap: 6, marginTop: 10 }}>
            {DAY_NAMES.map((n, i) => {
              const on = !!(d.weekdays & (1 << i));
              return (
                <Pressable key={n} onPress={() => set({ weekdays: d.weekdays ^ (1 << i) })} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={n}
                  style={{ flex: 1, minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5,
                    borderColor: on ? t.c.honeyEdge : t.c.cardLine, backgroundColor: on ? t.c.accentTint : t.c.card }}>
                  <T v={on ? 'bodyStrong' : 'body'} style={{ fontSize: 14 }}>{n}</T>
                </Pressable>
              );
            })}
          </View>
        ) : null}
        {errLine(errs.days)}
      </ScrollView>
      <View style={{ padding: 16, paddingBottom: 16 + ins.bottom, borderTopWidth: 1, borderTopColor: t.c.lineSoft, gap: 8 }}>
        {saveErr ? <T style={{ color: t.c.warn, fontSize: 14 }} accessibilityLiveRegion="polite">{saveErr}</T> : null}
        <Pressable onPress={save} accessibilityRole="button" accessibilityLabel="Save habit"
          style={({ pressed }) => ({ minHeight: 56, borderRadius: 16, backgroundColor: t.c.accentFill, borderWidth: 1.5, borderColor: t.c.honeyEdge, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.85 : 1 })}>
          <T v="button" style={{ color: t.c.onAccent, fontSize: 17 }}>Save habit</T>
        </Pressable>
      </View>
      <Modal visible={units} transparent animationType="slide" onRequestClose={() => setUnits(false)}>
        <Pressable style={{ flex: 1, backgroundColor: t.c.scrim }} onPress={() => setUnits(false)} accessibilityLabel="Close" />
        <View style={{ backgroundColor: t.c.sheet, borderTopLeftRadius: t.radius.sheet, borderTopRightRadius: t.radius.sheet, padding: 20, paddingBottom: 24 + ins.bottom }}>
          <T v="title" accessibilityRole="header" style={{ fontSize: 22, marginBottom: 8 }}>Unit</T>
          {UNITS.map((u) => (
            <Pressable key={u} onPress={() => { set({ unit: u }); setUnits(false); }} accessibilityRole="radio" accessibilityState={{ selected: d.unit === u }} accessibilityLabel={u}
              style={{ minHeight: 52, flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderTopColor: t.c.sheetLine }}>
              <T v={d.unit === u ? 'bodyStrong' : 'body'} style={{ fontSize: 17, flex: 1 }}>{u}</T>
              {d.unit === u ? <T style={{ color: t.c.accentText, fontSize: 17 }}>✓</T> : null}
            </Pressable>
          ))}
        </View>
      </Modal>
    </View>
  );
}
