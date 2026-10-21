import { useLocalSearchParams } from 'expo-router';
import { HabitDetail } from '@/features/habits/HabitDetail';

export default function HabitRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <HabitDetail id={String(id ?? '')} />;
}
