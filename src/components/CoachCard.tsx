import { memo } from 'react';
import { useRouter } from 'expo-router';
import type { Suggestion } from '../lib/coach';
import { Button, Card, Row, T } from './ui';

export const CoachCard = memo(function CoachCard({ kcalLeft, proteinLeft, picks, full }: { kcalLeft: number; proteinLeft: number; picks: Suggestion[]; full?: boolean }) {
  const router = useRouter();
  return (
    <Card tone="primarySoft">
      <T v="bodyStrong" tone="primaryText">
        {kcalLeft > 0 ? `You have ${kcalLeft} kcal and ${proteinLeft} g protein left. Try:` : 'You’re at your target for today. Light options tomorrow.'}
      </T>
      {picks.map((p) => (
        <Row key={p.dish.id} style={{ justifyContent: 'space-between' }}>
          <T style={{ flex: 1 }} tone="primaryText">{p.label}{full ? ` · ≈ ${p.kcal} kcal · ${p.protein} g protein` : ''}</T>
          <Button kind={full ? 'primary' : 'soft'} title={full ? '+ Log this' : 'Log'} accessibilityLabel={`Log ${p.label}`}
            onPress={() => router.push({ pathname: '/log', params: { prefill: p.label } })} />
        </Row>
      ))}
      <T v="caption" tone="muted">Picks from our dish table that fit what’s left{full ? ' · matches your diet setting' : ''}.</T>
    </Card>
  );
});
