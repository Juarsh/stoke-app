// Edit routine (item 9; full-b2 plan-builder, plan-builder-delete): routine name, the weekday chip, "N exercises · targets
// are optional", exercise rows (name, equipment · rest, target "4 × 6–8" or "Add target"), tap a row to open its Sets / Reps /
// Up to / Rest steppers, Add exercise (search the library), Save routine pinned at the bottom, Delete with a confirm.
// Reorder is Move up / Move down in the open row (also TalkBack actions); hold-and-drag waits for a later pass.
// Nothing is written until Save routine passes the checks; a refused save shows the reason and keeps every value as typed.
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { T } from '@/components/ui';
import { exercises, type Exercise, type ExerciseRepo } from '@/lib/exercises';
import { usePlans } from '@/lib/plans';
import { useTheme } from '@/theme';
import { search } from '../library/model';
import {
  countLabel, daysLabel, DEFAULT_REST, DEFAULT_TARGET, LIMITS, move, restLabel, Routine, RoutineExercise, step, stepReps, targetA11y, targetLabel, uniqueName, WEEKDAYS,
} from './model';
import { Box, Confirm, Header, HoneyButton, Stepper, TextLink } from './parts';

const LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

type Props = { id: string; planId: string; day?: number; repo?: ExerciseRepo };
export function RoutineScreen(p: Props) {
  const t = useTheme(); const plans = usePlans();
  // the editor starts from the saved routine, so it waits for the phone's plans to load
  return plans.ready ? <RoutineEditor {...p} /> : <View style={{ flex: 1, backgroundColor: t.c.bg }} />;
}
function RoutineEditor({ id, planId, day, repo = exercises }: Props) {
  const t = useTheme(); const router = useRouter(); const plans = usePlans(); const ins = useSafeAreaInsets();
  const plan = plans.planById(planId);
  const saved = plan?.routines.find((r) => r.id === id) ?? null;
  const [draft, setDraft] = useState<Routine | null>(() => saved ?? (plan && id === 'new'
    ? { id: plans.newId(), name: uniqueName(day !== undefined ? `${WEEKDAYS[day]} routine` : 'New routine', plan.routines.map((r) => r.name)), exercises: [] } : null));
  const [open, setOpen] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [del, setDel] = useState(false);
  if (!plan || !draft) return <View style={{ flex: 1, backgroundColor: t.c.bg }}><Header title="Edit routine" /><T tone="text2" style={{ padding: 20 }}>This routine was deleted.</T></View>;
  const isNew = !saved;
  const edit = (f: (r: Routine) => Routine) => { setErr(null); setDraft((d) => (d ? f(d) : d)); };
  const editEx = (i: number, f: (x: RoutineExercise) => RoutineExercise) => edit((r) => ({ ...r, exercises: r.exercises.map((x, j) => (j === i ? f(x) : x)) }));
  const chip = isNew && day !== undefined ? `${LONG[day]}s` : daysLabel(plan, draft.id);
  const save = () => {
    const e = plans.saveRoutine(plan.id, draft);
    if (e) { setErr(e); return; }
    if (isNew && day !== undefined) { const e2 = plans.setDay(plan.id, day, draft.id); if (e2) { setErr(e2); return; } }
    router.back();
  };
  const days = plan.days.map((d, i) => (d === draft.id ? LONG[i] : null)).filter(Boolean);
  return (
    <View style={{ flex: 1, backgroundColor: t.c.bg }}>
      <Header title={isNew ? 'New routine' : 'Edit routine'} right={isNew ? null : <TextLink title="Delete" onPress={() => setDel(true)} a11y={`Delete ${saved!.name}`} />} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, gap: 12, paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
        <T v="caption" tone="muted" style={{ fontSize: 14 }}>Routine name</T>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: 1.5, borderBottomColor: t.c.text2, marginTop: -8 }}>
          <TextInput value={draft.name} onChangeText={(v) => edit((r) => ({ ...r, name: v }))} maxLength={LIMITS.name} accessibilityLabel="Routine name"
            style={{ flex: 1, fontSize: 30, fontFamily: t.type.title.fontFamily, color: t.c.text, paddingVertical: 6, minHeight: 52 }} selectionColor={t.c.em} />
          <View style={{ backgroundColor: t.c.card2, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 }} accessible accessibilityLabel={`On ${chip}`}>
            <T v="bodyStrong" tone="text2" style={{ fontSize: 14 }}>{chip}</T>
          </View>
        </View>
        <T tone="muted" style={{ fontSize: 14 }}>{`${countLabel(draft.exercises.length)} · targets are optional`}</T>

        {draft.exercises.length ? (
          <Box>
            {draft.exercises.map((x, i) => {
              const e = repo.byId(x.exercise_id);
              const name = e?.name ?? 'Not in the library';
              const tl = targetLabel(x.target);
              const isOpen = open === i;
              return (
                <View key={`${x.exercise_id}-${i}`} style={{ borderTopWidth: i ? 1 : 0, borderTopColor: t.c.lineSoft }}>
                  <Pressable onPress={() => setOpen(isOpen ? null : i)} accessibilityRole="button" accessibilityState={{ expanded: isOpen }}
                    accessibilityLabel={`${name}, ${e?.equipment ?? ''}, ${restLabel(x.rest_s)}, ${targetA11y(x.target)}. ${isOpen ? 'Close' : 'Change'}`}
                    accessibilityActions={[{ name: 'up', label: 'Move up' }, { name: 'down', label: 'Move down' }]}
                    onAccessibilityAction={(ev) => edit((r) => ({ ...r, exercises: move(r.exercises, i, ev.nativeEvent.actionName === 'up' ? i - 1 : i + 1) }))}
                    style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 68, paddingHorizontal: 18, paddingVertical: 10, opacity: pressed ? 0.85 : 1 })}>
                    <View style={{ flex: 1, gap: 2 }}>
                      <T v="bodyStrong" tone={e ? 'text' : 'warn'} style={{ fontSize: 16 }}>{name}</T>
                      <T tone="muted" style={{ fontSize: 14 }}>{e ? `${e.equipment} · ` : ''}{restLabel(x.rest_s)}</T>
                    </View>
                    {tl ? <T v="bodyStrong" style={{ fontSize: 18 }}>{tl}</T> : <T v="bodyStrong" style={{ color: t.c.accentText, fontSize: 15 }}>Add target</T>}
                  </Pressable>
                  {isOpen ? (
                    <View style={{ paddingHorizontal: 18, paddingBottom: 14, gap: 12 }}>
                      {x.target ? (
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14 }}>
                          <Stepper label="Sets" value={x.target.sets} min={LIMITS.sets[0]} max={LIMITS.sets[1]} onStep={(d) => editEx(i, (y) => ({ ...y, target: { ...y.target!, sets: step(y.target!.sets, d, LIMITS.sets) } }))} />
                          <Stepper label="Reps" value={x.target.repsLow} min={LIMITS.reps[0]} max={LIMITS.reps[1]} onStep={(d) => editEx(i, (y) => ({ ...y, target: stepReps(y.target!, 'low', d) }))} />
                          <Stepper label="Up to" value={x.target.repsHigh} min={LIMITS.reps[0]} max={LIMITS.reps[1]} onStep={(d) => editEx(i, (y) => ({ ...y, target: stepReps(y.target!, 'high', d) }))} />
                        </View>
                      ) : null}
                      <Stepper label="Rest" value={x.rest_s} text={x.rest_s ? restLabel(x.rest_s).replace('rest ', '') : 'None'} min={LIMITS.rest[0]} max={LIMITS.rest[1]}
                        onStep={(d) => editEx(i, (y) => ({ ...y, rest_s: step(y.rest_s, d * LIMITS.restStep, LIMITS.rest) }))} />
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 6 }}>
                        {x.target ? <TextLink title="Remove target" onPress={() => editEx(i, (y) => ({ ...y, target: null }))} />
                          : <TextLink title="Add target" onPress={() => editEx(i, (y) => ({ ...y, target: { ...DEFAULT_TARGET } }))} a11y={`Add target for ${name}`} />}
                        {i > 0 ? <TextLink title="Move up" onPress={() => { edit((r) => ({ ...r, exercises: move(r.exercises, i, i - 1) })); setOpen(i - 1); }} /> : null}
                        {i < draft.exercises.length - 1 ? <TextLink title="Move down" onPress={() => { edit((r) => ({ ...r, exercises: move(r.exercises, i, i + 1) })); setOpen(i + 1); }} /> : null}
                        <TextLink title="Remove" onPress={() => { edit((r) => ({ ...r, exercises: r.exercises.filter((_, j) => j !== i) })); setOpen(null); }} a11y={`Remove ${name} from this routine`} />
                      </View>
                    </View>
                  ) : null}
                </View>
              );
            })}
          </Box>
        ) : null}
        <Pressable onPress={() => setPicker(true)} accessibilityRole="button" accessibilityLabel={`Add exercise. Search ${repo.all().length} exercises`}
          style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 60, paddingHorizontal: 18, borderRadius: 18, borderWidth: 1.5, borderStyle: 'dashed', borderColor: t.c.stateLine, opacity: pressed ? 0.85 : 1 })}>
          <Icon name="search" color={t.c.text} size={18} strokeWidth={2} />
          <T v="bodyStrong" style={{ flex: 1, fontSize: 16 }}>Add exercise</T>
          <T tone="muted" style={{ fontSize: 14 }}>{`Search ${repo.all().length} exercises`}</T>
        </Pressable>
        <T tone="muted" style={{ fontSize: 14, textAlign: 'center' }}>Tap an exercise to set a target or move it</T>
      </ScrollView>
      <View style={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 16 + ins.bottom, borderTopWidth: 1, borderTopColor: t.c.lineSoft, backgroundColor: t.c.card, gap: 8 }}>
        {err ? <T tone="warn" accessibilityLiveRegion="polite" style={{ fontSize: 14 }}>{err}</T> : null}
        <HoneyButton title="Save routine" onPress={save} />
      </View>
      <ExercisePicker visible={picker} repo={repo} onClose={() => setPicker(false)}
        onPick={(e) => { edit((r) => ({ ...r, exercises: [...r.exercises, { exercise_id: e.id, target: null, rest_s: DEFAULT_REST }] })); setPicker(false); }} />
      {saved ? (
        <Confirm visible={del} title={`Delete ${saved.name}?`}
          body={`${days.length ? `It comes off your ${days.join(' and ')} split. ` : ''}Past workouts stay in your history.`} keep="Keep routine" drop="Delete routine"
          onKeep={() => setDel(false)} onDrop={() => { setDel(false); plans.deleteRoutine(plan.id, saved.id); router.back(); }} />
      ) : null}
    </View>
  );
}

/** Add exercise: the library's own search (same ranking as Exercises), first 40 matches. */
function ExercisePicker({ visible, repo, onClose, onPick }: { visible: boolean; repo: ExerciseRepo; onClose: () => void; onPick: (e: Exercise) => void }) {
  const t = useTheme(); const ins = useSafeAreaInsets();
  const [q, setQ] = useState('');
  const rows = useMemo(() => search(repo, q).slice(0, 40), [repo, q]);
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ height: 80, backgroundColor: t.c.scrim }} onPress={onClose} accessibilityLabel="Close" />
      <View style={{ flex: 1, backgroundColor: t.c.sheet, borderTopLeftRadius: t.radius.sheet, borderTopRightRadius: t.radius.sheet, paddingTop: 10, paddingBottom: ins.bottom }}>
        <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: t.c.handle, alignSelf: 'center', marginBottom: 10 }} />
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20 }}>
          <T v="title" accessibilityRole="header" style={{ fontSize: 22, flex: 1 }}>Add exercise</T>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center', marginRight: -10 }}>
            <Icon name="x" color={t.c.text} size={20} strokeWidth={2.2} />
          </Pressable>
        </View>
        <View style={{ marginHorizontal: 20, marginVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 14, borderWidth: 1.5, borderColor: t.c.cardLine, paddingHorizontal: 14, minHeight: 52 }}>
          <Icon name="search" color={t.c.text2} size={18} strokeWidth={2} />
          <TextInput value={q} onChangeText={setQ} placeholder={`Search ${repo.all().length} exercises`} placeholderTextColor={t.c.muted} accessibilityLabel="Search exercises"
            style={{ flex: 1, fontSize: 16, color: t.c.text, fontFamily: t.type.body.fontFamily }} selectionColor={t.c.em} autoCorrect={false} />
        </View>
        <FlatList data={rows} keyExtractor={(e) => e.id} keyboardShouldPersistTaps="handled"
          ListEmptyComponent={<T tone="text2" style={{ padding: 20 }}>No exercise matches “{q}”.</T>}
          renderItem={({ item: e }) => (
            <Pressable onPress={() => onPick(e)} accessibilityRole="button" accessibilityLabel={`Add ${e.name}, ${e.group}, ${e.equipment}`}
              style={({ pressed }) => ({ minHeight: 56, paddingHorizontal: 20, paddingVertical: 8, justifyContent: 'center', borderTopWidth: 1, borderTopColor: t.c.sheetLine, opacity: pressed ? 0.85 : 1 })}>
              <T v="bodyStrong" style={{ fontSize: 16 }}>{e.name}</T>
              <T tone="muted" style={{ fontSize: 14 }}>{e.group} · {e.equipment}</T>
            </Pressable>
          )} />
      </View>
    </Modal>
  );
}
