import { useMemo } from 'react';
import { suggest } from './coach';
import { computeStreak, counted, dayTotals, localDate, loggedDays, stepsKcal } from './domain';
import { DISHES } from '../parser';
import { useStore } from './store';
import { pendingFor } from './syncQueue';

export function useDay(date = localDate()) {
  const st = useStore();
  return useMemo(() => {
    const p = st.profile;
    const entries = st.entries.filter((e) => e.local_date === date && counted(e));
    const reviews = st.entries.filter((e) => e.local_date === date && !e.deleted_at && e.needs_review);
    const pending = pendingFor(st.queue, date);
    const tot = dayTotals(entries);
    const steps = st.steps[date] ?? 0;
    const burn = stepsKcal(steps);
    const kcalTarget = (p?.kcalTarget ?? 2000) + (p?.addStepKcal ? burn : 0);
    const proteinTarget = p?.proteinTarget ?? 60;
    const kcalLeft = kcalTarget - tot.kcal;
    const proteinLeft = Math.max(0, Math.round((proteinTarget - tot.protein) * 10) / 10);
    const loggedDates = loggedDays(st.entries, pendingFor(st.queue).map((f) => f.local_date));
    const streak = computeStreak(loggedDates, localDate());
    const picks = suggest(DISHES, Math.max(0, kcalLeft), proteinLeft, p?.diet ?? 'veg');
    return { date, entries, reviews, pending, tot, steps, burn, kcalTarget, proteinTarget, kcalLeft, proteinLeft, streak, picks, loggedDates, profile: p };
  }, [st.entries, st.steps, st.profile, st.queue, date]);
}
