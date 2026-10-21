// v3.2 onboarding (Oct 16): 2 steps, no account or sign-in. Step 1 goal + diet; step 2 age, sex, height/weight,
// activity with a live "Your daily target" (Mifflin-St Jeor x activity, goal adjust, guard rails in computeTargets).
// Sex stays on this phone: it is never sent to the server (serverProfile / stripSex).
// P1 item 2 (Oct 21): full-b2 restyle (spec Q29: tokens only, same layout); age/height/weight are checked against the
// server's ranges (profileFieldErrors) instead of silently falling back to defaults; saved on the phone via the store.
import { useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { Button, Row, Screen, T } from '@/components/ui';
import { computeTargets, Diet, fieldNumber, Goal, Profile, ProfileField, profileFieldErrors, Sex } from '@/lib/domain';
import { grams, kc } from '@/lib/format';
import { useStore } from '@/lib/store';
import { makeStyles, useTheme } from '@/theme';

type Act = 'light' | 'moderate' | 'active';
const ACT_HELP: Record<Act, string> = { light: 'Low: mostly sitting, little exercise', moderate: 'Some: walk daily or gym 2–3 times a week', active: 'Active: hard exercise or a physical job most days' };

function Choice<V extends string>({ value, options, onChange, label, small }: { value: V; options: { value: V; label: string }[]; onChange: (v: V) => void; label: string; small?: boolean }) {
  const t = useTheme(); const s = useStyles();
  return (
    <View style={{ flexDirection: 'row', gap: 8 }} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable key={o.value} onPress={() => onChange(o.value)} accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={o.label}
            style={[s.chip, on ? { backgroundColor: t.c.accentTint, borderColor: t.c.honeyEdge, borderWidth: 2 } : { backgroundColor: t.c.card, borderColor: t.c.cardLine }]}>
            <T v="bodyStrong" style={[{ color: t.c.text }, small && { fontSize: 15, lineHeight: 18, textAlign: "center" }]} numberOfLines={small ? 2 : 1}>{o.label}</T>
          </Pressable>
        );
      })}
    </View>
  );
}

function NumField({ label, unit, value, onChange, onBlur, error }: { label: string; unit?: string; value: string; onChange: (v: string) => void; onBlur?: () => void; error?: string }) {
  const t = useTheme(); const s = useStyles();
  return (
    <View style={{ gap: 4 }}>
    <View style={[s.field, error ? { borderColor: t.c.warn, borderWidth: 1.5 } : null]}>
      <T v="caption" tone="muted">{label}</T>
      <Row style={{ gap: 4, width: '100%' }}>
        <View style={{ flex: 1, minWidth: 0 }}><TextInput value={value} onChangeText={(x) => onChange(x.replace(/[^0-9]/g, '').slice(0, 3))} keyboardType="number-pad" accessibilityLabel={label} onBlur={onBlur}
          accessibilityHint={error}
          selectionColor={t.c.em} style={[t.type.body, { flex: 1, minWidth: 0, width: '100%' as never, fontSize: 15, fontWeight: '700', color: t.c.text, padding: 0 }]} /></View>
        {unit ? <T v="caption" tone="muted">{unit}</T> : null}
      </Row>
    </View>
    {error ? <T v="caption" tone="warn" accessibilityLiveRegion="polite">⚠ {error}</T> : null}
    </View>
  );
}

export default function Onboarding() {
  const t = useTheme(); const s = useStyles(); const st = useStore();
  const [step, setStep] = useState<1 | 2>(st.profileError ? 2 : 1);
  // values already on the phone (e.g. the server refused the profile) are kept, never reset
  const pr = st.profile;
  const [goal, setGoal] = useState<Goal>(pr?.goal ?? 'maintain');
  const [diet, setDiet] = useState<Diet>(pr?.diet ?? 'veg');
  const [sex, setSex] = useState<Sex>(pr?.sex ?? 'x');
  const [age, setAge] = useState(String(pr?.age ?? 25)); const [h, setH] = useState(String(pr?.heightCm ?? 170)); const [w, setW] = useState(String(pr?.weightKg ?? 70));
  const [activity, setActivity] = useState<Act>(pr?.activity === 'light' || pr?.activity === 'active' ? pr.activity : 'moderate');
  // a field's error shows once it has been left (blur) or after Start logging was tapped
  const [seen, setSeen] = useState<Partial<Record<ProfileField, boolean>>>({}); const [tried, setTried] = useState(false);
  const errs = profileFieldErrors({ age, heightCm: h, weightKg: w });
  const shown = (k: ProfileField) => (tried || seen[k] ? errs[k] : undefined);
  const leave = (k: ProfileField) => () => setSeen((p) => ({ ...p, [k]: true }));
  const valid = Object.keys(errs).length === 0;
  const base = { goal, sex, age: fieldNumber(age) ?? 0, heightCm: fieldNumber(h) ?? 0, weightKg: fieldNumber(w) ?? 0, activity: activity as Profile['activity'] };
  const tgt = valid ? computeTargets(base) : null;
  const top = (
    <View style={{ gap: 8 }}>
      <Row style={{ justifyContent: 'space-between', minHeight: 44 }}>
        {step === 2 ? <Pressable onPress={() => setStep(1)} accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center', paddingRight: 12 }}><T tone="text2">← Back</T></Pressable> : <View />}
        <T tone="muted">{step} of 2</T>
      </Row>
      <View style={s.track} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 2, now: step }}>
        <View style={[s.fill, { width: step === 1 ? '50%' : '100%' }]} />
      </View>
    </View>
  );
  if (step === 1) {
    return (
      <Screen>
        {top}
        <T v="title" style={{ fontSize: 26, lineHeight: 32 }}>What’s your goal?</T>
        <Choice label="Goal" value={goal} onChange={setGoal} options={[{ value: 'lose', label: 'Lose' }, { value: 'maintain', label: 'Maintain' }, { value: 'gain', label: 'Gain' }]} />
        <T v="title" style={{ fontSize: 20, lineHeight: 26 }}>What do you eat?</T>
        <T v="caption" tone="muted">We use this for Coach picks.</T>
        <Choice label="Diet" value={diet} onChange={setDiet} options={[{ value: 'veg', label: 'Veg' }, { value: 'egg', label: 'Egg' }, { value: 'nonveg', label: 'Non-veg' }]} />
        <T v="caption" tone="muted">No account needed to start.</T>
        <Button title="Next" onPress={() => setStep(2)} style={{ marginTop: 8 }} />
      </Screen>
    );
  }
  return (
    <Screen>
      {top}
      <T v="title" style={{ fontSize: 26, lineHeight: 32 }}>About you</T>
      <NumField label="Age" unit="yrs" value={age} onChange={setAge} onBlur={leave('age')} error={shown('age')} />
      <T v="bodyStrong">Sex</T>
      <Choice label="Sex" small value={sex} onChange={setSex} options={[{ value: 'm', label: 'Male' }, { value: 'f', label: 'Female' }, { value: 'x', label: 'Prefer not to say' }]} />
      <T v="caption" tone="muted">Only used to work out your target. Stays on this phone.</T>
      <Row style={{ gap: 8, alignItems: 'flex-start' }}>
        <View style={{ flex: 1 }}><NumField label="Height" unit="cm" value={h} onChange={setH} onBlur={leave('heightCm')} error={shown('heightCm')} /></View>
        <View style={{ flex: 1 }}><NumField label="Weight" unit="kg" value={w} onChange={setW} onBlur={leave('weightKg')} error={shown('weightKg')} /></View>
      </Row>
      <T v="bodyStrong">Activity</T>
      <Choice label="Activity" value={activity} onChange={setActivity} options={[{ value: 'light', label: 'Low' }, { value: 'moderate', label: 'Some' }, { value: 'active', label: 'Active' }]} />
      <T v="caption" tone="muted">{ACT_HELP[activity]}</T>
      <View style={s.target} accessible accessibilityLiveRegion="polite"
        accessibilityLabel={tgt ? `Your daily target: ${kc(tgt.kcal)} calories, ${tgt.protein} grams protein` : 'Your daily target: check the fields above'}>
        <T v="caption" tone="text2">Your daily target</T>
        {tgt
          ? <T v="bodyStrong" style={{ fontSize: 18, lineHeight: 24 }}>{kc(tgt.kcal)} kcal · {grams(tgt.protein)} protein</T>
          : <T v="bodyStrong" tone="text2" style={{ fontSize: 16, lineHeight: 22 }}>Check the fields above</T>}
        <T v="caption" tone="muted">Updates as you change the fields above</T>
      </View>
      {st.profileError ? <T tone="text2" accessibilityLiveRegion="polite">Couldn’t save this. Check it and try again.</T> : null}
      <Button title="Start logging" onPress={() => { setTried(true); if (!tgt) return; st.setProfile({ ...base, diet, kcalTarget: tgt.kcal, proteinTarget: tgt.protein, maintenanceKcal: tgt.maintenance, stepsTarget: pr?.stepsTarget ?? 8000, addStepKcal: pr?.addStepKcal ?? false, showKcalOnCards: pr?.showKcalOnCards ?? true }); }} />
      <T v="caption" tone="muted" style={{ textAlign: 'center' }}>Edit later in Settings</T>
    </Screen>
  );
}
const useStyles = makeStyles((t) => ({
  chip: { flex: 1, minHeight: 48, borderRadius: t.radius.tile, borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  field: { minHeight: 60, borderRadius: t.radius.tile, borderWidth: 1, borderColor: t.c.cardLine, backgroundColor: t.c.card, paddingHorizontal: 12, paddingVertical: 8, justifyContent: 'center', gap: 2 },
  track: { height: 4, borderRadius: 2, backgroundColor: t.c.track, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2, backgroundColor: t.c.em },
  target: { backgroundColor: t.c.card, borderRadius: t.radius.card, borderWidth: 1, borderColor: t.c.lineSoft, padding: 12, gap: 2 },
}));
