import { useMemo } from 'react';
import { suggest } from './coach';
import { computeStreak, dayTotals, localDate, stepsKcal } from './domain';
import { DISHES } from '../parser';
import { useStore } from './store';

export function useDay(date = localDate()) {
  const st = useStore();
  return useMemo(() => {
    const p = st.profile;
    const entries = st.entries.filter((e) => e.local_date === date && !e.deleted_at);
    const tot = dayTotals(entries);
    const steps = st.steps[date] ?? 0;
    const burn = stepsKcal(steps);
    const kcalTarget = (p?.kcalTarget ?? 2000) + (p?.addStepKcal ? burn : 0);
    const proteinTarget = p?.proteinTarget ?? 60;
    const kcalLeft = kcalTarget - tot.kcal;
    const proteinLeft = Math.max(0, Math.round((proteinTarget - tot.protein) * 10) / 10);
    const loggedDates = new Set(st.entries.filter((e) => !e.deleted_at).map((e) => e.local_date));
    const streak = computeStreak(loggedDates, localDate());
    const picks = suggest(DISHES, Math.max(0, kcalLeft), proteinLeft, p?.diet ?? 'veg');
    return { date, entries, tot, steps, burn, kcalTarget, proteinTarget, kcalLeft, proteinLeft, streak, picks, loggedDates, profile: p };
  }, [st.entries, st.steps, st.profile, date]);
}
