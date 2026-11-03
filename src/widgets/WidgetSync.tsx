// Keeps the home-screen widgets in step with the app: any change to today's food, targets, theme, habits, plans or the
// workout in progress redraws them (debounced; after the providers have saved). Renders nothing; a no-op where the
// widget module isn't in the build (Expo Go, iOS, web, tests).
import { useEffect, useRef } from 'react';
import { useHabits } from '../lib/habits';
import { usePlans } from '../lib/plans';
import { useStore } from '../lib/store';
import { useWorkouts } from '../lib/workouts';
import { refreshWidgets, widgetsAvailable } from './refresh';

export const WIDGET_DEBOUNCE_MS = 600;
export function WidgetSync({ refresh = refreshWidgets, available = widgetsAvailable }: { refresh?: () => Promise<void>; available?: () => boolean }) {
  const st = useStore(), hb = useHabits(), pl = usePlans(), wo = useWorkouts();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ready = st.ready && hb.ready && pl.ready && wo.ready;
  useEffect(() => {
    if (!ready || !available()) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; refresh().catch(() => {}); }, WIDGET_DEBOUNCE_MS);
  }, [ready, st.entries, st.profile, st.steps, st.themePref, hb.state, pl.state, wo.state]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return null;
}
