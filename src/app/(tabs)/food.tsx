import { useRouter } from 'expo-router';
import { Button } from '@/components/ui';
import { StubScreen } from '@/features/shell/StubScreen';

/** Food tab stub: the day timeline lands in build-plan item 6. Logging still works through the existing flow. */
export default function Food() {
  const router = useRouter();
  return (
    <StubScreen title="Food" note="Your day of food by time arrives in a later build.">
      {/* tab bar is visible here, so the in-content action stays quiet (outlined), not honey */}
      <Button title="Log food" kind="outline" onPress={() => router.push('/log-food')} />
      {/* the old Today list (items, review and sync rows) stays reachable here until the timeline lands */}
      <Button title="Today's log" kind="ghost" onPress={() => router.push('/today')} />
    </StubScreen>
  );
}
