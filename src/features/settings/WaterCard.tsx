// Settings → Water (home-screen Water widget). Water is a Count habit (so it syncs, has a streak, and shows on Home like
// any habit); this card turns it on with 8 glasses a day, and its target is changed in the habit's own form (the same
// checks as any habit: a bad target is refused with the reason, never clamped).
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Button, Card, Row, T } from '@/components/ui';
import { active, isWaterHabit, targetText, snapOf, waterDraft } from '@/features/habits/model';
import { useHabits } from '@/lib/habits';
import { useLogDay } from '@/lib/useLogDay';

export function WaterCard() {
  const hb = useHabits(); const router = useRouter(); const today = useLogDay();
  const [err, setErr] = useState<string | null>(null);
  if (!hb.ready) return null;
  const w = active(hb.state).find(isWaterHabit) ?? null;
  const track = () => {
    const r = hb.create(waterDraft(), today);
    if (typeof r === 'string') { setErr(r); return; }
    setErr(null); router.push({ pathname: '/habit-form', params: { id: r.id } } as never);
  };
  return (
    <Card>
      <Row style={{ justifyContent: 'space-between', minHeight: 48 }}>
        <T style={{ flex: 1 }}>{w ? `Water · ${targetText(snapOf(w))} a day` : 'Water'}</T>
        {w ? <Button kind="soft" title="Change target" onPress={() => router.push({ pathname: '/habit-form', params: { id: w.id } } as never)} />
          : <Button kind="soft" title="Track water" onPress={track} />}
      </Row>
      {err ? <T v="caption" tone="warn" accessibilityLiveRegion="polite">⚠ {err}</T> : null}
    </Card>
  );
}
