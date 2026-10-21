import { Stack } from 'expo-router';
import { useTheme } from '@/theme';

/** Train tab stack: Train, Exercises (library) and an exercise's how-to page keep the tab bar with Train lit. */
export default function TrainLayout() {
  const t = useTheme();
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.c.bg } }} />;
}
