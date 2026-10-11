import { useRouter } from 'expo-router';
import { memo } from 'react';
import { ScrollView } from 'react-native';
import type { Suggestion } from '../lib/coach';
import { Button, Card, Chip, Row, T } from './ui';

/** Coach gradient card. compact = Today (horizontal pills); full = Coach tab (rows with Log buttons). */
export const CoachCard = memo(function CoachCard({ kcalLeft, proteinLeft, picks, full, dietLabel }: { kcalLeft: number; proteinLeft: number; picks: Suggestion[]; full?: boolean; dietLabel: string }) {
  const router = useRouter();
  const log = (p: Suggestion) => router.push({ pathname: '/log', params: { prefill: p.label } });
  return (
    <Card tone="coach">
      <Row style={{ justifyContent: 'space-between' }}>
        <T v="bodyStrong" tone="onCoach" style={{ flex: 1 }}>
          <T tone="goldOnGrad">✦ </T>{kcalLeft > 0 ? `Fill ${kcalLeft} kcal · ${proteinLeft} g protein` : 'You’re at your target for today'}
        </T>
        <T v="caption" tone="onCoach">{dietLabel}</T>
      </Row>
      {full ? picks.map((p) => (
        <Row key={p.dish.id} style={{ justifyContent: 'space-between' }}>
          <T tone="onCoach" style={{ flex: 1 }}>{p.label} · ≈ {p.kcal} kcal · {p.protein} g</T>
          <Button kind="onCoach" title="+ Log" accessibilityLabel={`Log ${p.label}`} onPress={() => log(p)} />
        </Row>
      )) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {picks.map((p) => <Chip key={p.dish.id} kind="onCoach" label={`${p.label} +`} a11y={`Log ${p.label}, about ${p.kcal} calories`} onPress={() => log(p)} />)}
        </ScrollView>
      )}
      {full ? <T v="caption" tone="onCoach">Picks from our own dish table that fit what’s left. Never over target.</T> : null}
    </Card>
  );
});
