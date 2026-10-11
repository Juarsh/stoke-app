import { useState } from 'react';
import { View } from 'react-native';
import { Button, Card, Field, Row, Screen, Segmented, T } from '@/components/ui';
import { computeTargets, Diet, Goal, Profile } from '@/lib/domain';
import { useStore } from '@/lib/store';

export default function Onboarding() {
  const st = useStore();
  const [goal, setGoal] = useState<Goal>('maintain');
  const [sex, setSex] = useState<'m' | 'f'>('m');
  const [age, setAge] = useState('25'); const [h, setH] = useState('170'); const [w, setW] = useState('70');
  const [activity, setActivity] = useState<Profile['activity']>('light');
  const [diet, setDiet] = useState<Diet>('veg');
  const base = { goal, sex, age: Number(age) || 25, heightCm: Number(h) || 170, weightKg: Number(w) || 70, activity };
  const auto = computeTargets(base);
  const [kcal, setKcal] = useState(''); const [protein, setProtein] = useState('');
  return (
    <Screen title="Your goal">
      <T v="bodyStrong">What’s the goal?</T>
      <Segmented value={goal} onChange={setGoal} options={[{ value: 'lose', label: 'Lose fat' }, { value: 'maintain', label: 'Maintain' }, { value: 'gain', label: 'Gain muscle' }]} />
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
      <Card tone="primarySoft">
        <T v="caption" tone="primaryText">Suggested daily target (editable)</T>
        <Row>
          <View style={{ flex: 1 }}><Field label="kcal" keyboardType="numeric" placeholder={String(auto.kcal)} value={kcal} onChangeText={setKcal} /></View>
          <View style={{ flex: 1 }}><Field label="Protein g" keyboardType="numeric" placeholder={String(auto.protein)} value={protein} onChangeText={setProtein} /></View>
        </Row>
        <T v="caption" tone="muted">Estimated with Mifflin-St Jeor ({goal === 'lose' ? '−400' : goal === 'gain' ? '+300' : '±0'} kcal) and {goal === 'maintain' ? 1.2 : 1.6} g protein per kg.</T>
      </Card>
      <Button title="Start logging" onPress={() => st.setProfile({ ...base, diet, kcalTarget: Number(kcal) || auto.kcal, proteinTarget: Number(protein) || auto.protein, stepsTarget: 8000, addStepKcal: false, showKcalOnCards: true })} />
    </Screen>
  );
}
