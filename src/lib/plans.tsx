// Plans on the phone (build-plan item 9): the weekly split and its routines, kept through the LocalStore seam (./data)
// under their own key, offline first. Every change goes through the save checks in features/plans/model (a refused change
// returns its reason and nothing is written). Server sync for plans arrives with P4 (item 15) through the API client.
import * as Crypto from 'expo-crypto';
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { localStore } from './data';
import { exercises, type ExerciseRepo } from './exercises';
import {
  blankPlan, EMPTY_PLANS, fromTemplate, Plan, planError, parsePlans, PlansState, removeRoutine, Routine, routineError, setDay as setDayOf, stamp, upsertRoutine,
} from '../features/plans/model';

export const PLANS_KEY = 'plans-v1';

function usePlansValue(wipeGen: number, repo: ExerciseRepo) {
  const [s, setS] = useState<PlansState>(EMPTY_PLANS);
  const [ready, setReady] = useState(false);
  const ref = useRef(s); ref.current = s;
  // written only after a change made here (loading never writes back)
  const dirty = useRef(false);
  useEffect(() => { localStore.load(PLANS_KEY).then((raw) => setS(parsePlans(raw))).catch(() => {}).finally(() => setReady(true)); }, []);
  useEffect(() => { if (ready && dirty.current) localStore.save(PLANS_KEY, JSON.stringify(s)).catch(() => {}); }, [s, ready]);
  // Delete account (Settings) wipes plans with the rest of the on-device store
  const firstGen = useRef(wipeGen);
  useEffect(() => { if (wipeGen !== firstGen.current) { dirty.current = true; setS(EMPTY_PLANS); } }, [wipeGen]);

  const commit = useCallback((next: PlansState) => { dirty.current = true; ref.current = next; setS(next); }, []);
  const now = () => new Date().toISOString();
  const newId = () => Crypto.randomUUID();
  const planById = useCallback((id: string) => ref.current.plans.find((p) => p.id === id) ?? null, []);
  /** Replace one plan after the save checks; returns the reason when it is refused (nothing changes then). */
  const put = useCallback((p: Plan, makeActive = false): string | null => {
    const err = planError(p, repo);
    if (err) return err;
    const cur = ref.current;
    const plans = cur.plans.some((x) => x.id === p.id) ? cur.plans.map((x) => (x.id === p.id ? stamp(p, now()) : x)) : [...cur.plans, p];
    commit({ ...cur, plans, activeId: makeActive || !cur.activeId ? p.id : cur.activeId });
    return null;
  }, [commit, repo]);

  return useMemo(() => ({
    ready, state: s, planById,
    /** "Use Push · Pull · Legs": a new plan from the template, made the active one. */
    applyTemplate: (key: string): Plan => { const p = fromTemplate(key, newId, now(), ref.current.plans.map((x) => x.name)); put(p, true); return p; },
    /** "Build my own routine" / "+ New plan": an empty week (all rest); active only when there is no active plan. */
    newPlan: (): Plan => { const p = blankPlan(newId, now(), ref.current.plans.map((x) => x.name)); put(p); return p; },
    renamePlan: (id: string, name: string) => { const p = planById(id); return p ? put({ ...p, name }) : 'This plan was deleted.'; },
    setActive: (id: string) => { if (planById(id)) commit({ ...ref.current, activeId: id }); },
    deletePlan: (id: string) => { const cur = ref.current; commit({ ...cur, plans: cur.plans.filter((p) => p.id !== id), activeId: cur.activeId === id ? null : cur.activeId }); },
    setDay: (planId: string, weekday: number, routineId: string | null) => { const p = planById(planId); return p ? put(setDayOf(p, weekday, routineId)) : 'This plan was deleted.'; },
    /** Save routine: checks the routine (name, exercises, targets, rest) before anything is written. */
    saveRoutine: (planId: string, r: Routine): string | null => {
      const p = planById(planId);
      if (!p) return 'This plan was deleted.';
      const err = routineError({ ...r, name: r.name.trim() }, repo, p.routines.filter((x) => x.id !== r.id).map((x) => x.name));
      return err ?? put(upsertRoutine(p, { ...r, name: r.name.trim() }));
    },
    deleteRoutine: (planId: string, routineId: string) => { const p = planById(planId); return p ? put(removeRoutine(p, routineId)) : null; },
    newId,
  }), [ready, s, planById, put, commit, repo]);
}
export type Plans = ReturnType<typeof usePlansValue>;
const Ctx = createContext<Plans | null>(null);
export function PlansProvider({ children, wipeGen = 0, repo = exercises }: { children: ReactNode; wipeGen?: number; repo?: ExerciseRepo }) {
  const v = usePlansValue(wipeGen, repo);
  return <Ctx.Provider value={v}>{children}</Ctx.Provider>;
}
export function usePlans(): Plans {
  const v = useContext(Ctx);
  if (!v) throw new Error('PlansProvider missing');
  return v;
}
