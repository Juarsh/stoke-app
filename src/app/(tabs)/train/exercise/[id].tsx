import { useLocalSearchParams } from 'expo-router';
import { ExerciseScreen } from '@/features/library/ExerciseScreen';

export default function ExerciseHowTo() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ExerciseScreen id={String(id)} />;
}
