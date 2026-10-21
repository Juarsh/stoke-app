import { useLocalSearchParams } from 'expo-router';
import { PlanScreen } from '@/features/plans/PlanScreen';

export default function PlanRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <PlanScreen id={String(id)} />;
}
