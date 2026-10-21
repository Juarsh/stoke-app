// Active workout logger (build-plan item 10; full-b2 active-logger / -finish / -discard, states #10 bodyweight and #11 empty
// workout). Header: "<title> · started 6:10 PM", the running time and Finish (soft, top right); Volume / Sets / Exercises.
// Each exercise: SET · PREVIOUS · KG · REPS · DONE; empty boxes show last time in grey and one tap on ✓ logs them; a done row
// is tinted with a filled tick; a finished exercise collapses to one line. ⋯ has Remove set / Remove exercise (the swipe
// to remove comes later; the menu is the accessible path the design asks for). The rest timer is item 11; the summary
// screen is item 12 (until then Finish returns to Train with a one-line notice).
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { T } from '@/components/ui';
import { exercises, type ExerciseRepo } from '@/lib/exercises';
import { useStore } from '@/lib/store';
import { useWorkouts } from '@/lib/workouts';
import { useTheme } from '@/theme';
import { ExercisePicker } from '../plans/ExercisePicker';
import { restLabel } from '../plans/model';
import { Confirm, HoneyButton, TextLink } from '../plans/parts';
import { clock, doneLine, elapsed, finishAsk, ghost, kindOf, minutes, prevLabel, Session, SessionExercise, stats } from './model';

const n = (x: number) => Math.round(x).toLocaleString('en-IN');
export const savedLine = (s: Session, volume: number) => `${s.title} saved · ${minutes(s.started_at, Date.parse(s.ended_at!))} min · ${n(volume)} kg`;

export function LoggerScreen({ repo = exercises }: { repo?: ExerciseRepo }) {
  const t = useTheme(); const ins = useSafeAreaInsets(); const router = useRouter(); const w = useWorkouts(); const st = useStore();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const [ask, setAsk] = useState<null | 'discard' | 'confirm'>(null);
  const [picker, setPicker] = useState(false);
  const a = w.active;
  if (!w.ready) return <View style={{ flex: 1, backgroundColor: t.c.bg }} />;
  if (!a) {
    return (
      <View style={{ flex: 1, backgroundColor: t.c.bg, paddingTop: ins.top + 20, paddingHorizontal: 20, gap: 12 }}>
        <T v="title" accessibilityRole="header">No workout in progress</T>
        <TextLink title="Back to Train" onPress={() => router.replace('/train' as never)} />
      </View>
    );
  }
  const s = stats(a, repo);
  const fa = finishAsk(a);
  const save = () => {
    setAsk(null);
    const r = w.finish();
    if (typeof r === 'string') { st.showNotice(r); return; }
    st.showNotice(savedLine(r, stats(r, repo).volume));
    router.back();
  };
  const onFinish = () => { if (fa.kind === 'save') save(); else setAsk(fa.kind); };
  const stat = (label: string, value: string) => (
    <View style={{ flex: 1, gap: 2 }} accessible accessibilityLabel={`${label}: ${value}`}>
      <T tone="text2" style={{ fontSize: 14 }}>{label}</T>
      <T v="title" style={{ fontSize: 22 }}>{value}</T>
    </View>
  );
  return (
    <View style={{ flex: 1, backgroundColor: t.c.bg }}>
      <View style={{ paddingTop: ins.top + 10, paddingHorizontal: 20, paddingBottom: 14, gap: 12, borderBottomWidth: 1, borderBottomColor: t.c.lineSoft }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <T tone="text2" style={{ fontSize: 14 }}>{`${a.title} · started ${clock(a.started_at)}`}</T>
            <T v="display" accessibilityRole="timer" accessibilityLabel={`Time ${elapsed(a.started_at, now)}`} style={{ fontSize: 32, lineHeight: 40 }}>{elapsed(a.started_at, now)}</T>
          </View>
          <Pressable onPress={onFinish} accessibilityRole="button" accessibilityLabel="Finish workout"
            style={({ pressed }) => ({ minHeight: 52, paddingHorizontal: 18, borderRadius: 16, borderWidth: 1.5, borderColor: t.c.cardLine, backgroundColor: t.c.card2, justifyContent: 'center', opacity: pressed ? 0.85 : 1 })}>
            <T v="bodyStrong" style={{ fontSize: 17 }}>Finish</T>
          </Pressable>
        </View>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          {stat('Volume', `${n(s.volume)} kg`)}{stat('Sets', `${s.done} of ${s.total}`)}{stat('Exercises', `${s.started} of ${s.exercises}`)}
        </View>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 + ins.bottom }} keyboardShouldPersistTaps="handled">
        {a.exercises.length ? a.exercises.map((x) => <ExerciseCard key={x.id} x={x} repo={repo} />) : (
          <View testID="logger-empty" style={{ borderRadius: t.radius.card, borderWidth: 1.5, borderStyle: 'dashed', borderColor: t.c.stateLine, padding: 20, gap: 8, alignItems: 'center' }}>
            <T v="bodyStrong" style={{ fontSize: 17 }}>No exercises yet</T>
            <T tone="text2" style={{ fontSize: 14 }}>Add one to start logging sets.</T>
            <View style={{ alignSelf: 'stretch', marginTop: 6 }}><HoneyButton title="Add exercise" onPress={() => setPicker(true)} /></View>
          </View>
        )}
        {a.exercises.length ? (
          <Pressable onPress={() => setPicker(true)} accessibilityRole="button" accessibilityLabel="Add exercise"
            style={({ pressed }) => ({ minHeight: 52, borderRadius: 16, borderWidth: 1.5, borderStyle: 'dashed', borderColor: t.c.stateLine, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: pressed ? 0.85 : 1 })}>
            <Icon name="plus" color={t.c.text} size={18} strokeWidth={2.2} /><T v="bodyStrong" style={{ fontSize: 16 }}>Add exercise</T>
          </Pressable>
        ) : null}
      </ScrollView>
      <ExercisePicker visible={picker} repo={repo} onClose={() => setPicker(false)} onPick={(e) => { w.addExercise(e.id); setPicker(false); }} />
      <Confirm visible={ask === 'discard'} title="Discard workout?" body="No sets are ticked, so there is nothing to save." keep="Keep going" drop="Discard workout"
        onKeep={() => setAsk(null)} onDrop={() => { setAsk(null); w.discard(); router.back(); }} />
      <Confirm visible={ask === 'confirm'} title="Finish workout?" body={fa.kind === 'confirm' ? `${fa.undone} of ${fa.total} sets not done. Only ticked sets are saved.` : ''}
        keep="Keep going" drop="Finish anyway" onKeep={() => setAsk(null)} onDrop={save} />
    </View>
  );
}

function ExerciseCard({ x, repo }: { x: SessionExercise; repo: ExerciseRepo }) {
  const t = useTheme(); const w = useWorkouts();
  const e = repo.byId(x.exercise_id);
  const kind = kindOf(e);
  const name = e?.name ?? 'Exercise';
  const allDone = x.sets.length > 0 && x.sets.every((y) => y.done);
  const [open, setOpen] = useState(!allDone);
  const [menu, setMenu] = useState(false);
  const [errs, setErrs] = useState<Record<string, string>>({});
  useEffect(() => { if (allDone) setOpen(false); }, [allDone]);
  const prev = w.previous(x.exercise_id);
  const card = { backgroundColor: t.c.card, borderRadius: t.radius.card, borderWidth: 1, borderColor: t.c.lineSoft, overflow: 'hidden' } as const;
  if (allDone && !open) {
    return (
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={`${name}, done. ${doneLine(x, kind)}. Open`}
        style={({ pressed }) => [card, { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, minHeight: 64, opacity: pressed ? 0.85 : 1 }]}>
        <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: t.c.sageFill, alignItems: 'center', justifyContent: 'center' }}><T style={{ color: t.c.card, fontSize: 15 }}>✓</T></View>
        <View style={{ flex: 1 }}>
          <T v="bodyStrong" style={{ fontSize: 17 }}>{name}</T>
          <T tone="text2" style={{ fontSize: 14 }}>{doneLine(x, kind)}</T>
        </View>
        <Icon name="chev" color={t.c.text2} size={18} strokeWidth={2.2} />
      </Pressable>
    );
  }
  const kgHead = kind === 'weight' ? 'KG' : '+KG';
  const repsHead = kind === 'time' ? 'SEC' : 'REPS';
  const firstOpen = x.sets.findIndex((y) => !y.done);
  const g0 = firstOpen >= 0 ? ghost(prev, firstOpen, x.target) : null;
  const hint = g0 && g0.reps && !x.sets[firstOpen].kg_in && !x.sets[firstOpen].reps_in && prev.length
    ? `Grey is last time. Tap ✓ to log ${kind === 'weight' ? `${g0.kg} × ${g0.reps}` : prevLabel({ kg: g0.kg ? Number(g0.kg) : null, reps: Number(g0.reps) }, kind)}.` : null;
  const col = { set: 28, done: 50 };
  const box = (val: string, ph: string, label: string, onChange: (v: string) => void, done: boolean) => done
    ? <T v="bodyStrong" style={{ flex: 1, flexBasis: 0, minWidth: 0, textAlign: 'center', fontSize: 17 }} accessibilityLabel={`${label} ${val || ph}`}>{val || ph}</T>
    : <TextInput value={val} onChangeText={onChange} placeholder={ph} placeholderTextColor={t.c.muted} keyboardType="decimal-pad" accessibilityLabel={label} selectionColor={t.c.em}
      style={{ flex: 1, flexBasis: 0, minWidth: 0, width: 0, minHeight: 48, borderRadius: 12, backgroundColor: t.c.card2, textAlign: 'center', fontSize: 17, color: t.c.text, fontFamily: t.type.body.fontFamily }} />;
  return (
    <View style={card} testID={`ex-${x.exercise_id}`}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingTop: 12 }}>
        <View style={{ flex: 1 }}>
          <T v="bodyStrong" style={{ fontSize: 17 }}>{name}</T>
          <T tone="text2" style={{ fontSize: 14 }}>{`${e?.equipment ?? ''} · ${restLabel(x.rest_s)}`}</T>
        </View>
        <Pressable onPress={() => setMenu(true)} accessibilityRole="button" accessibilityLabel={`More for ${name}`} style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}>
          <T v="bodyStrong" style={{ fontSize: 20 }}>⋯</T>
        </Pressable>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 8, gap: 6 }} importantForAccessibility="no-hide-descendants">
        {[['SET', col.set], ['PREVIOUS', 0], [kgHead, 0], [repsHead, 0], ['DONE', col.done]].map(([h, wd]) => (
          <T key={String(h)} v="eyebrow" tone="text2" style={{ fontSize: 12, textAlign: h === 'PREVIOUS' ? 'left' : 'center', ...(wd ? { width: Number(wd) } : { flex: h === 'PREVIOUS' ? 1.5 : 1, flexBasis: 0, minWidth: 0 }) }}>{String(h)}</T>
        ))}
      </View>
      {x.sets.map((y, i) => {
        const g = ghost(prev, i, x.target);
        const err = errs[y.id];
        const ph = kind === 'weight' ? g.kg : g.kg ? `BW +${g.kg}` : 'BW';
        return (
          <View key={y.id} style={{ backgroundColor: y.done ? t.c.accentTint : 'transparent', borderTopWidth: 1, borderTopColor: t.c.lineSoft }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 6, gap: 6, minHeight: 60 }}>
              <T v="bodyStrong" style={{ width: col.set, textAlign: 'center', fontSize: 16 }}>{String(i + 1)}</T>
              <T tone="text2" style={{ flex: 1.5, flexBasis: 0, minWidth: 0, fontSize: 14 }}>{prevLabel(prev[i], kind)}</T>
              {kind === 'time' ? <T tone="muted" style={{ flex: 1, flexBasis: 0, textAlign: 'center' }}>—</T>
                : box(y.done ? (kind === 'weight' ? y.kg_in : '') : y.kg_in, y.done ? (kind === 'weight' ? '' : y.kg ? `BW +${y.kg_in}` : 'BW') : ph, `Set ${i + 1} ${kind === 'weight' ? 'kg' : 'added kg'}`,
                  (v) => { setErrs((m) => ({ ...m, [y.id]: '' })); w.setInput(x.id, y.id, 'kg_in', v); }, y.done)}
              {box(y.reps_in, g.reps, `Set ${i + 1} ${kind === 'time' ? 'seconds' : 'reps'}`, (v) => { setErrs((m) => ({ ...m, [y.id]: '' })); w.setInput(x.id, y.id, 'reps_in', v); }, y.done)}
              <View style={{ width: col.done, alignItems: 'center' }}>
                <Pressable onPress={() => { if (y.done) { w.untick(x.id, y.id); return; } const r = w.tick(x.id, y.id); setErrs((m) => ({ ...m, [y.id]: r ?? '' })); }}
                  accessibilityRole="checkbox" accessibilityState={{ checked: y.done }} accessibilityLabel={`Set ${i + 1} done`}
                  style={{ width: 48, height: 48, borderRadius: 12, borderWidth: y.done ? 0 : 2, borderColor: t.c.stateLine, backgroundColor: y.done ? t.c.sageFill : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                  {y.done ? <T style={{ color: t.c.card, fontSize: 20 }}>✓</T> : null}
                </Pressable>
              </View>
            </View>
            {err ? <T tone="warn" accessibilityLiveRegion="polite" style={{ fontSize: 14, paddingHorizontal: 16, paddingBottom: 8 }}>{err}</T> : null}
          </View>
        );
      })}
      <View style={{ padding: 12, gap: 8 }}>
        {hint ? <T tone="text2" style={{ fontSize: 14 }}>{hint}</T> : null}
        {kind === 'bodyweight' ? <T tone="muted" style={{ fontSize: 13 }}>BW is your bodyweight. Volume counts added kg only.</T> : null}
        <Pressable onPress={() => w.addSet(x.id)} accessibilityRole="button" accessibilityLabel={`Add set to ${name}`}
          style={({ pressed }) => ({ minHeight: 48, borderRadius: 14, borderWidth: 1.5, borderStyle: 'dashed', borderColor: t.c.stateLine, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: pressed ? 0.85 : 1 })}>
          <Icon name="plus" color={t.c.text} size={16} strokeWidth={2.2} /><T v="bodyStrong" style={{ fontSize: 16 }}>Add set</T>
        </Pressable>
      </View>
      <Modal visible={menu} transparent animationType="slide" onRequestClose={() => setMenu(false)}>
        <Pressable style={{ flex: 1, backgroundColor: t.c.scrim }} onPress={() => setMenu(false)} accessibilityLabel="Close" />
        <View style={{ backgroundColor: t.c.sheet, borderTopLeftRadius: t.radius.sheet, borderTopRightRadius: t.radius.sheet, padding: 20, paddingBottom: 32, gap: 2 }}>
          <T v="title" accessibilityRole="header" style={{ fontSize: 20, marginBottom: 8 }}>{name}</T>
          {x.sets.length ? <TextLink title={`Remove set ${x.sets.length}`} onPress={() => { w.removeSet(x.id, x.sets[x.sets.length - 1].id); setMenu(false); }} /> : null}
          <TextLink title="Remove exercise" onPress={() => { w.removeExercise(x.id); setMenu(false); }} a11y={`Remove ${name} from this workout`} />
        </View>
      </Modal>
    </View>
  );
}
