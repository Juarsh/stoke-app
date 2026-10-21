// The log day (spec §4, §12: the day starts at 4 AM). Screens left open re-render when it rolls over at 04:00 (a timer to
// the next day start, plus a re-check when the app comes back to the foreground).
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { addDays, dayOf, dayStartAt } from './domain';

/** ms until the next day start after `now` (pure, testable) */
export const msToNextDay = (now: Date) => dayStartAt(addDays(dayOf(now), 1)).getTime() - now.getTime();

export function useLogDay(now: () => Date = () => new Date()) {
  const [day, setDay] = useState(() => dayOf(now()));
  useEffect(() => {
    const check = () => setDay(dayOf(now()));
    const id = setTimeout(check, Math.max(1000, msToNextDay(now()) + 1000));
    const sub = AppState.addEventListener?.('change', (s) => { if (s === 'active') check(); });
    return () => { clearTimeout(id); sub?.remove?.(); };
  }, [day]); // eslint-disable-line react-hooks/exhaustive-deps
  return day;
}
