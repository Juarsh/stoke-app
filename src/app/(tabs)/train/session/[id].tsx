import { useLocalSearchParams } from 'expo-router';
import { SessionScreen } from '@/features/workout/SessionScreen';

export default function SessionRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <SessionScreen id={String(id ?? '')} />;
}
