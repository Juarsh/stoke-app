// Habits on the phone (build-plan items 13–14): habits and their daily logs through the LocalStore seam (./data) under
// their own key, offline first; server sync arrives with P4. Every change goes through the checks in features/habits/model
// (a refused change returns its reason and nothing is written). Also holds the habit toast ("Push-ups done · Undo ·
// Change", Q8 4 s) and the Home settle clock (Q7: the B2 row reorders 4 s after the last toast closes).
import * as Crypto from 'expo-crypto';
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { localStore } from './data';
import {
  Draft, draftErrors, EMPTY_HABITS, firstError, fromDraft, fullValue, Habit, HabitLog, HabitsState, logDateError, logOf, parseHabits, snapOf,
} from '../features/habits/model';

export const HABITS_KEY = 'habits-v1';
/** Q7: the Home row settles this long after the last habit toast closes */
export const SETTLE_MS = 4000;
export interface HabitToast { key: number; habitId: string; date: string; text: string; prev: HabitLog | null; change: boolean }

function useHabitsValue(wipeGen: number, now: () => Date) {
  const [s, setS] = useState<HabitsState>(EMPTY_HABITS);
  const [ready, setReady] = useState(false);
  const ref = useRef(s); ref.current = s;
  const dirty = useRef(false);
  useEffect(() => { localStore.load(HABITS_KEY).then((raw) => setS(parseHabits(raw))).catch(() => {}).finally(() => setReady(true)); }, []);
  useEffect(() => { if (ready && dirty.current) localStore.save(HABITS_KEY, JSON.stringify(s)).catch(() => {}); }, [s, ready]);
  const firstGen = useRef(wipeGen);
  useEffect(() => { if (wipeGen !== firstGen.current) { dirty.current = true; setS(EMPTY_HABITS); } }, [wipeGen]);
  const commit = useCallback((next: HabitsState) => { dirty.current = true; ref.current = next; setS(next); }, []);

  // toast + settle clock
  const [toast, setToast] = useState<HabitToast | null>(null);
  const [settleGen, setSettleGen] = useState(0);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastSeq = useRef(0);
  const openToast = useCallback((t: Omit<HabitToast, 'key'>) => {
    if (settleTimer.current) { clearTimeout(settleTimer.current); settleTimer.current = null; }
    setToast({ ...t, key: ++toastSeq.current });
  }, []);
  const closeToast = useCallback(() => {
    setToast(null);
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => { settleTimer.current = null; setSettleGen((g) => g + 1); }, SETTLE_MS);
  }, []);
  useEffect(() => () => { if (settleTimer.current) clearTimeout(settleTimer.current); }, []);

  const habitById = useCallback((id: string) => ref.current.habits.find((h) => h.id === id) ?? null, []);
  /** write one day's log (null removes it) */
  const putLog = useCallback((habitId: string, date: string, log: HabitLog | null) => {
    const cur = ref.current;
    const logs = cur.logs.filter((l) => !(l.habit_id === habitId && l.local_date === date));
    commit({ ...cur, logs: log ? [...logs, log] : logs });
  }, [commit]);
  const today = () => now();

  return useMemo(() => {
    const nowIso = () => today().toISOString();
    /** set the amount for a day: full target → done; 0 → no log; partial → undone with the amount (§10.4) */
    const setAmount = (habitId: string, date: string, value: number | null, todayDate: string): string | null => {
      const h = habitById(habitId); if (!h) return 'This habit was deleted.';
      const derr = logDateError(date, todayDate); if (derr) return derr;
      const prev = logOf(ref.current, habitId, date);
      const snap = prev?.target_snapshot ?? snapOf(h);
      const full = fullValue(snap);
      if (value !== null) {
        if (snap.kind === 'done') return 'This habit is yes / no.';
        if (!Number.isInteger(value) || value < 0 || value > (full ?? 0)) return `Enter a whole number from 0 to ${full}.`;
      }
      if (value === 0) { putLog(habitId, date, null); return null; }
      const done = value === null || value === full;
      putLog(habitId, date, { id: prev?.id ?? Crypto.randomUUID(), habit_id: habitId, local_date: date, value: snap.kind === 'done' ? null : (value ?? full),
        done, target_snapshot: snap, logged_at: nowIso() });
      return null;
    };
    return {
      ready, state: s, habitById, toast, settleGen,
      /** Save habit (Create): checks first; new habits go last in the user's order and start today. */
      create: (d: Draft, todayDate: string): Habit | string => {
        const err = firstError(draftErrors(d, ref.current.habits)); if (err) return err;
        const cur = ref.current; const t = nowIso();
        const h: Habit = { id: Crypto.randomUUID(), ...fromDraft(d), starts_on: todayDate, position: cur.habits.reduce((m, x) => Math.max(m, x.position + 1), 0),
          archived_at: null, created_at: t, updated_at: t };
        commit({ ...cur, habits: [...cur.habits, h] });
        return h;
      },
      /** Edit: a new target applies to days logged from now on; past logs keep their target_snapshot (§10.3). */
      update: (id: string, d: Draft): string | null => {
        const h = habitById(id); if (!h) return 'This habit was deleted.';
        const err = firstError(draftErrors(d, ref.current.habits.filter((x) => x.id !== id))); if (err) return err;
        const cur = ref.current;
        commit({ ...cur, habits: cur.habits.map((x) => (x.id === id ? { ...x, ...fromDraft(d), updated_at: nowIso() } : x)) });
        return null;
      },
      /** Archive keeps the history (§10.3); it leaves Home and the Habits list. */
      archive: (id: string) => { const cur = ref.current; commit({ ...cur, habits: cur.habits.map((x) => (x.id === id ? { ...x, archived_at: nowIso() } : x)) }); },
      /** One tap: done at the full target, or un-tick a done day. Opens the toast. Returns a reason when refused. */
      toggle: (habitId: string, date: string, todayDate: string): string | null => {
        const h = habitById(habitId); if (!h) return 'This habit was deleted.';
        const prev = logOf(ref.current, habitId, date);
        if (prev?.done) {
          const err = logDateError(date, todayDate); if (err) return err;
          putLog(habitId, date, null);
        } else {
          const err = setAmount(habitId, date, null, todayDate); if (err) return err;
        }
        openToast({ habitId, date, prev, text: `${h.short_name} ${prev?.done ? 'undone' : 'done'}`, change: !prev?.done && h.kind !== 'done' });
        return null;
      },
      setAmount: (habitId: string, date: string, value: number, todayDate: string) => setAmount(habitId, date, value, todayDate),
      /** Undo in the toast: the day goes back exactly as it was (no reorder: the row is frozen while a toast is up). */
      undo: (t: HabitToast) => { putLog(t.habitId, t.date, t.prev); },
      closeToast,
    };
  }, [ready, s, habitById, toast, settleGen, commit, putLog, openToast, closeToast]); // eslint-disable-line react-hooks/exhaustive-deps
}
export type Habits = ReturnType<typeof useHabitsValue>;
const Ctx = createContext<Habits | null>(null);
export function HabitsProvider({ children, wipeGen = 0, now = () => new Date() }: { children: ReactNode; wipeGen?: number; now?: () => Date }) {
  const v = useHabitsValue(wipeGen, now);
  return <Ctx.Provider value={v}>{children}</Ctx.Provider>;
}
const NONE: Habits = {
  ready: false, state: EMPTY_HABITS, habitById: () => null, toast: null, settleGen: 0,
  create: () => 'Habits aren’t ready yet.', update: () => 'Habits aren’t ready yet.', archive: () => {}, toggle: () => 'Habits aren’t ready yet.',
  setAmount: () => 'Habits aren’t ready yet.', undo: () => {}, closeToast: () => {},
};
export const useHabits = () => useContext(Ctx) ?? NONE;
