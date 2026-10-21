// Workouts on the phone (build-plan item 10): the workout in progress and finished workouts, kept through the LocalStore
// seam (./data) under their own key, offline first. The workout in progress is saved on every change, so a killed app
// resumes it (states #7). Ticking a set goes through the logger's checks (a refused tick returns its reason and keeps the
// typed text). Server sync arrives with P4 (item 15) through the API client.
import * as Crypto from 'expo-crypto';
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { localStore } from './data';
import { exercises, type ExerciseRepo } from './exercises';
import type { Routine } from '../features/plans/model';
import {
  checkSet, EMPTY_WORKOUTS, finished, fmtKg, ghost, kindOf, newExercise, parseWorkouts, previousSets, Session, SessionExercise, sessionError,
  restAfter, shiftRest, startEmpty, startFromRoutine, WorkoutsState, WSet,
} from '../features/workout/model';

export const WORKOUTS_KEY = 'workouts-v1';
export const NO_WORKOUT = 'This workout was already finished or discarded.';

function useWorkoutsValue(wipeGen: number, repo: ExerciseRepo, now: () => Date) {
  const [s, setS] = useState<WorkoutsState>(EMPTY_WORKOUTS);
  const [ready, setReady] = useState(false);
  const ref = useRef(s); ref.current = s;
  const dirty = useRef(false);
  useEffect(() => { localStore.load(WORKOUTS_KEY).then((raw) => setS(parseWorkouts(raw))).catch(() => {}).finally(() => setReady(true)); }, []);
  useEffect(() => { if (ready && dirty.current) localStore.save(WORKOUTS_KEY, JSON.stringify(s)).catch(() => {}); }, [s, ready]);
  const firstGen = useRef(wipeGen);
  useEffect(() => { if (wipeGen !== firstGen.current) { dirty.current = true; setS(EMPTY_WORKOUTS); } }, [wipeGen]);
  const commit = useCallback((next: WorkoutsState) => { dirty.current = true; ref.current = next; setS(next); }, []);
  const newId = () => Crypto.randomUUID();
  /** change the workout in progress; false when there is none */
  const edit = useCallback((f: (a: Session) => Session) => { const a = ref.current.active; if (!a) return false; commit({ ...ref.current, active: f(a) }); return true; }, [commit]);
  const editEx = useCallback((exId: string, f: (x: SessionExercise) => SessionExercise) =>
    edit((a) => ({ ...a, exercises: a.exercises.map((x) => (x.id === exId ? f(x) : x)) })), [edit]);
  const editSet = useCallback((exId: string, setId: string, f: (y: WSet) => WSet) =>
    editEx(exId, (x) => ({ ...x, sets: x.sets.map((y) => (y.id === setId ? f(y) : y)) })), [editEx]);

  return useMemo(() => ({
    ready, state: s, active: s.active,
    /** Start workout from a routine; a workout already in progress is kept and returned instead (never overwritten). */
    start: (r: Routine, planId: string): Session => { const a = ref.current.active; if (a) return a; const n = startFromRoutine(r, planId, newId, now()); commit({ ...ref.current, active: n }); return n; },
    startEmpty: (): Session => { const a = ref.current.active; if (a) return a; const n = startEmpty(newId, now()); commit({ ...ref.current, active: n }); return n; },
    previous: (exerciseId: string) => previousSets(ref.current.sessions, exerciseId),
    setInput: (exId: string, setId: string, field: 'kg_in' | 'reps_in', v: string) => editSet(exId, setId, (y) => (y.done ? y : { ...y, [field]: v })),
    /** Tap ✓: the typed numbers (or the grey ones) are checked; refused → the reason, nothing changes. */
    tick: (exId: string, setId: string): string | null => {
      const a = ref.current.active; if (!a) return NO_WORKOUT;
      const x = a.exercises.find((e) => e.id === exId); const i = x?.sets.findIndex((y) => y.id === setId) ?? -1;
      if (!x || i < 0) return NO_WORKOUT;
      const kind = kindOf(repo.byId(x.exercise_id));
      const y = x.sets[i];
      const r = checkSet(y.kg_in, y.reps_in, ghost(previousSets(ref.current.sessions, x.exercise_id), i, x.target), kind);
      if (!r.ok) return r.reason;
      const t = now();
      editSet(exId, setId, (z) => ({ ...z, done: true, kg: r.kg, reps: r.reps, kg_in: r.kg === null ? '' : fmtKg(r.kg), reps_in: String(r.reps), done_at: t.toISOString() }));
      // rest timer C (item 11): ticking starts this exercise's rest towards the next open set
      edit((b) => ({ ...b, rest: restAfter(b, exId, setId, t.getTime()) }));
      return null;
    },
    /** Tap a filled ✓ again: the set is open again with its numbers in the boxes. */
    untick: (exId: string, setId: string) => editSet(exId, setId, (y) => ({ ...y, done: false, kg: null, reps: null, done_at: null })),
    addSet: (exId: string) => editEx(exId, (x) => ({ ...x, sets: [...x.sets, { id: newId(), kg_in: '', reps_in: '', done: false, kg: null, reps: null, done_at: null }] })),
    removeSet: (exId: string, setId: string) => editEx(exId, (x) => ({ ...x, sets: x.sets.filter((y) => y.id !== setId) })),
    addExercise: (exerciseId: string) => edit((a) => ({ ...a, exercises: [...a.exercises, newExercise(exerciseId, newId)] })),
    removeExercise: (exId: string) => edit((a) => ({ ...a, exercises: a.exercises.filter((x) => x.id !== exId) })),
    /** Finish: only ticked sets are saved. Returns the saved workout, or the reason it can't be saved. */
    finish: (): Session | string => {
      const a = ref.current.active; if (!a) return NO_WORKOUT;
      const err = sessionError(a); if (err) return err;
      const f = finished(a, now());
      if (!f.exercises.length) return 'No sets are ticked, so there is nothing to save.';
      commit({ ...ref.current, active: null, sessions: [...ref.current.sessions, f] });
      return f;
    },
    discard: () => commit({ ...ref.current, active: null }),
    /** Session detail ⋯ → Delete workout (after a confirm). */
    deleteSession: (id: string) => commit({ ...ref.current, sessions: ref.current.sessions.filter((s) => s.id !== id) }),
    /** Skip / Skip rest / the done pill fading: the rest timer goes away. */
    endRest: () => edit((a) => ({ ...a, rest: null })),
    /** −15s / +15s */
    shiftRest: (ds: number) => edit((a) => (a.rest ? { ...a, rest: shiftRest(a.rest, ds, now().getTime()) } : a)),
    setVibrate: (on: boolean) => commit({ ...ref.current, prefs: { ...ref.current.prefs, vibrate: on } }),
  }), [ready, s, commit, edit, editEx, editSet, repo, now]);
}
export type Workouts = ReturnType<typeof useWorkoutsValue>;
const Ctx = createContext<Workouts | null>(null);
const realNow = () => new Date();
export function WorkoutsProvider({ children, wipeGen = 0, repo = exercises, now = realNow }: { children: ReactNode; wipeGen?: number; repo?: ExerciseRepo; now?: () => Date }) {
  const v = useWorkoutsValue(wipeGen, repo, now);
  return <Ctx.Provider value={v}>{children}</Ctx.Provider>;
}
export function useWorkouts(): Workouts {
  const v = useContext(Ctx);
  if (!v) throw new Error('WorkoutsProvider missing');
  return v;
}
