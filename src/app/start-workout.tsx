// stoke://start-workout (Workout home-screen widget): one tap starts today's workout and opens the logger. It decides from
// the data as it is now (not from the widget's last drawing): a workout in progress resumes (never replaced); today's
// routine starts; a rest day starts an empty workout only when asked (?empty=1, the widget's "Start anyway"); no plan
// goes to Train.
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { useLogDay } from '@/lib/useLogDay';
import { usePlans } from '@/lib/plans';
import { useWorkouts } from '@/lib/workouts';
import { startTarget } from '@/widgets/model';

export default function StartWorkout() {
  const plans = usePlans(); const w = useWorkouts(); const date = useLogDay();
  const { empty } = useLocalSearchParams<{ empty?: string }>();
  const router = useRouter(); const done = useRef(false);
  useEffect(() => {
    if (!plans.ready || !w.ready || done.current) return;
    done.current = true;
    const t = startTarget(plans.state, w.state, date, empty === '1');
    if (t.start === 'routine') w.start(t.routine, t.planId);
    else if (t.start === 'empty') w.startEmpty();
    router.replace(t.to as never);
  }, [plans.ready, w.ready]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
