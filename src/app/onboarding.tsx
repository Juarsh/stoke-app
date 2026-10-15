// v3.2 frame 2, two steps. Step 1 "What's your goal?": goal buttons, "About you" summary grid, target as hero numbers
// (computed, real values), Start logging. Step 2 "About you": edit the details and, optionally, the target.
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Button, Field, Row, Screen, Segmented, T } from '@/components/ui';
import { computeTargets, Diet, Goal, Profile } from '@/lib/domain';
import { grams, kc } from '@/lib/format';
import { useStore } from '@/lib/store';
import { makeStyles, useTheme } from '@/theme';

const GOALS: { value: Goal; label: string }[] = [{ value: 'lose', label: 'Lose fat' }, { value: 'maintain', label: 'Maintain' }, { value: 'gain', label: 'Gain muscle' }];
const ACT: Record<Profile['activity'], string> = { sedentary: 'Desk job', light: 'Light', moderate: 'Gym 3–4×/wk', active: 'Daily' };
const DIET: Record<Diet, string> = { veg: 'Veg', egg: 'Egg + veg', nonveg: 'Non-veg' };

export default function Onboarding() {
  const t = useTheme(); const s = useStyles(); const st = useStore();
  const [step, setStep] = useState<1 | 2>(1);
  const [goal, setGoal] = useState<Goal>('maintain');
  const [sex, setSex] = useState<'m' | 'f'>('m');
  const [age, setAge] = useState('25'); const [h, setH] = useState('170'); const [w, setW] = useState('70');
  const [activity, setActivity] = useState<Profile['activity']>('light');
  const [diet, setDiet] = useState<Diet>('veg');
  const base = { goal, sex, age: Number(age) || 25, heightCm: Number(h) || 170, weightKg: Number(w) || 70, activity };
  const auto = computeTargets(base);
  // user overrides; empty = follow the computed value (always shown as real text, never as a placeholder)
  const [kOver, setKOver] = useState(''); const [pOver, setPOver] = useState('');
  const kcal = Number(kOver) || auto.kcal, protein = Number(pOver) || auto.protein;
  const header = (n: 1 | 2) => (
    <Row style={{ justifyContent: 'space-between' }}>
      {n === 2 ? <T tone="text2" accessibilityRole="button" onPress={() => setStep(1)} style={{ paddingVertical: 8 }}>← Back</T> : <View />}
      <T tone="text2">Step {n} of 2</T>
    </Row>
  );
  if (step === 2) {
    return (
      <Screen>
        {header(2)}
        <T v="title">About you</T>
        <Segmented value={sex} onChange={setSex} options={[{ value: 'm', label: 'Male' }, { value: 'f', label: 'Female' }]} />
        <Row>
          <View style={{ flex: 1 }}><Field label="Age" keyboardType="numeric" value={age} onChangeText={setAge} /></View>
          <View style={{ flex: 1 }}><Field label="Height cm" keyboardType="numeric" value={h} onChangeText={setH} /></View>
          <View style={{ flex: 1 }}><Field label="Weight kg" keyboardType="numeric" value={w} onChangeText={setW} /></View>
        </Row>
        <T v="bodyStrong">Activity</T>
        <Segmented value={activity} onChange={setActivity} options={[{ value: 'sedentary', label: 'Desk' }, { value: 'light', label: 'Light' }, { value: 'moderate', label: '3–4×/wk' }, { value: 'active', label: 'Daily' }]} />
        <T v="bodyStrong">Food (for coach picks)</T>
        <Segmented value={diet} onChange={setDiet} options={[{ value: 'veg', label: 'Veg' }, { value: 'egg', label: 'Egg + veg' }, { value: 'nonveg', label: 'Non-veg' }]} />
        <T v="bodyStrong">Your daily target</T>
        <Row>
          <View style={{ flex: 1 }}><Field label="kcal" keyboardType="numeric" value={kOver || String(auto.kcal)} onChangeText={setKOver} /></View>
          <View style={{ flex: 1 }}><Field label="Protein g" keyboardType="numeric" value={pOver || String(auto.protein)} onChangeText={setPOver} /></View>
        </Row>
        <Button title="Done" onPress={() => setStep(1)} />
      </Screen>
    );
  }
  const tiles: [string, string][] = [['Sex', sex === 'm' ? 'Male' : 'Female'], ['Age', String(base.age)], ['Food', DIET[diet]],
    ['Height', `${base.heightCm} cm`], ['Weight', `${base.weightKg} kg`], ['Activity', ACT[activity]]];
  return (
    <Screen>
      {header(1)}
      <T v="title">What’s your goal?</T>
      <Row style={{ gap: 8 }}>
        {GOALS.map((o) => {
          const on = o.value === goal;
          return (
            <Pressable key={o.value} onPress={() => setGoal(o.value)} accessibilityRole="radio" accessibilityState={{ selected: on }}
              style={[s.goal, on && { backgroundColor: t.c.em, borderColor: t.c.em }]}>
              <T v="bodyStrong" style={on ? { color: t.dark ? t.c.onAccent : '#FFFFFF' } : undefined}>{o.label}</T>
            </Pressable>
          );
        })}
      </Row>
      <T v="caption" tone="muted">About you</T>
      <View style={s.grid}>
        {tiles.map(([k, v]) => (
          <Pressable key={k} onPress={() => setStep(2)} style={s.tile} accessibilityRole="button" accessibilityLabel={`${k}: ${v}. Edit`}>
            <T v="caption" tone="muted">{k}</T><T v="bodyStrong">{v}</T>
          </Pressable>
        ))}
      </View>
      <Pressable onPress={() => setStep(2)} style={s.target} accessibilityRole="button" accessibilityLabel={`Your daily target: ${kc(kcal)} calories, ${Math.round(protein)} grams protein. Edit`}>
        <T v="caption" tone="text2">Your daily target · you can edit this</T>
        <Row style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
          <Row style={{ alignItems: 'baseline', gap: 4 }}><T v="displayM">{kc(kcal)}</T><T tone="text2">kcal</T></Row>
          <Row style={{ alignItems: 'baseline', gap: 4 }}><T v="displayM">{grams(protein)}</T><T tone="text2">protein</T></Row>
        </Row>
        <T v="caption" tone="text2">Estimated with the Mifflin-St Jeor formula</T>
      </Pressable>
      <Button title="Start logging" onPress={() => st.setProfile({ ...base, diet, kcalTarget: kcal, proteinTarget: protein, stepsTarget: 8000, addStepKcal: false, showKcalOnCards: true })} />
    </Screen>
  );
}
const useStyles = makeStyles((t) => ({
  goal: { flex: 1, minHeight: 48, borderRadius: t.radius.tile, borderWidth: 1, borderColor: t.c.cardLine, backgroundColor: t.c.card, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tile: { width: '31.5%' as never, minHeight: 64, borderRadius: t.radius.tile, borderWidth: 1, borderColor: t.c.cardLine, backgroundColor: t.c.card, padding: 10, gap: 2 },
  target: { backgroundColor: t.c.accentTint, borderRadius: t.radius.card, borderWidth: 1, borderColor: t.c.emTintLine, padding: t.space.cardH, gap: 4 },
}));
