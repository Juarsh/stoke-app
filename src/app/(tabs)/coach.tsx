import { CoachCard } from '@/components/CoachCard';
import { Screen, T } from '@/components/ui';
import { useDay } from '@/lib/useDay';

export default function Coach() {
  const d = useDay();
  return (
    <Screen title="Coach">
      <T tone="muted">{d.profile?.diet === 'veg' ? 'Veg' : d.profile?.diet === 'egg' ? 'Egg + veg' : 'Veg and non-veg'} picks from our own dish table.</T>
      <CoachCard kcalLeft={d.kcalLeft} proteinLeft={d.proteinLeft} picks={d.picks} full dietLabel={d.profile?.diet === 'veg' ? 'Veg' : d.profile?.diet === 'egg' ? 'Egg' : 'Non-veg'} />
      <T v="caption" tone="muted">After 3 days over target, picks lean lighter. No warnings.</T>
    </Screen>
  );
}
