import { useEffect, useMemo, useState } from 'react';
import { coachPicks } from './coach';
import { computeStreak, counted, toReview, dayTotals, localDate, loggedDays, stepsKcal } from './domain';
import { DISHES } from '../parser';
import { useStore } from './store';
import { isOffline, isStale, pendingFor, STALE_PENDING_MS } from './syncQueue';

export function useDay(date = localDate()) {
  const st = useStore();
  // re-evaluate when the next fresh pending item turns stale (~10 s)
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const ats = pendingFor(st.queue).map((f) => (f.at ?? 0) + STALE_PENDING_MS - Date.now()).filter((ms) => ms > 0);
    if (!ats.length) return;
    const t = setTimeout(() => setTick((x) => x + 1), Math.min(...ats) + 50);
    return () => clearTimeout(t);
  }, [st.queue, tick]);
  return useMemo(() => {
    const p = st.profile;
    const entries = st.entries.filter((e) => e.local_date === date && counted(e));
    const reviews = st.entries.filter((e) => e.local_date === date && toReview(e));
    /** entries whose change could not be synced: only those rows say "Couldn’t sync this. Tap to retry" */
    const syncFailed = st.entries.filter((e) => e.local_date === date && (!!e.sync_error || !!e.sync_retrying));
    const allPending = pendingFor(st.queue, date);
    const now = Date.now();
    const pending = allPending.filter((f) => !isStale(f, now));
    const stale = allPending.filter((f) => isStale(f, now));
    const offline = isOffline(st.queue);
    const tot = dayTotals(entries);
    const steps = st.steps[date] ?? 0;
    const burn = stepsKcal(steps);
    const kcalTarget = (p?.kcalTarget ?? 2000) + (p?.addStepKcal ? burn : 0);
    const proteinTarget = p?.proteinTarget ?? 60;
    const kcalLeft = kcalTarget - tot.kcal;
    const proteinLeft = Math.max(0, Math.round((proteinTarget - tot.protein) * 10) / 10);
    const loggedDates = loggedDays(st.entries, pendingFor(st.queue).map((f) => f.local_date));
    const streak = computeStreak(loggedDates, localDate());
    const picks = coachPicks(DISHES, Math.max(0, kcalLeft), proteinLeft, p?.diet ?? 'veg');
    return { date, entries, reviews, syncFailed, pending, stale, offline, reviewCount: reviews.length + stale.length, tot, steps, burn, kcalTarget, proteinTarget, kcalLeft, proteinLeft, streak, picks, loggedDates, profile: p };
  }, [st.entries, st.steps, st.profile, st.queue, date, tick]);
}
