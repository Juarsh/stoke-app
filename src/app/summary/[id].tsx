import { useLocalSearchParams } from 'expo-router';
import { SummaryScreen } from '@/features/workout/SummaryScreen';

export default function SummaryRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <SummaryScreen id={String(id ?? '')} />;
}
