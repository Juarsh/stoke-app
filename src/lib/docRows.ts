// M4 (build-plan items 15–16): plans, finished workouts, habits and habit logs as server rows ("docs"), with the same rules
// as food entries. Pure: the phone's records <-> the API's bodies, what to queue after a change (a body that differs from
// the last one queued, a delete for a record that went), and how a flush answer or a pull lands on the phone's state.
// The server's row is the truth: a 409 (another device saved first) puts the server's row on the phone; a refusal keeps
// the phone's value and says why; a row deleted on another device goes. The 4 AM day stays the phone's (dayOf).
import type { DocRow } from './api';
import type { DocResult } from './syncQueue';
import type { ExerciseRepo } from './exercises';
import type { Plan, PlansState } from '../features/plans/model';
import { fmtKg, kindOf, type Session, type WorkoutsState } from '../features/workout/model';
import type { Habit, HabitLog, HabitsState } from '../features/habits/model';

export type DocKind = 'plan' | 'workout' | 'habit' | 'habitLog';
export type Body = Record<string, unknown>;
export const KINDS: DocKind[] = ['plan', 'workout', 'habit', 'habitLog'];
export const docKey = (kind: DocKind, id: string) => `${kind}:${id}`;
export const kindOfKey = (key: string) => key.slice(0, key.indexOf(':')) as DocKind;
export const logKey = (l: Pick<HabitLog, 'habit_id' | 'local_date'>) => docKey('habitLog', `${l.habit_id}/${l.local_date}`);
/** What the phone knows about each doc on the server: the version of its row, and the last body queued for it. */
export interface Ledger { uid: string | null; v: Record<string, number>; sent: Record<string, string> }
export const EMPTY_LEDGER: Ledger = { uid: null, v: {}, sent: {} };
export interface Local { plans: PlansState; workouts: WorkoutsState; habits: HabitsState }

// ---- phone -> server -----------------------------------------------------------------------------------------------
export function planBody(p: Plan, activeId: string | null): Body {
  return { name: p.name, days: p.days.map((d) => d ?? ''), active: p.id === activeId,
    routines: p.routines.map((r) => ({ id: r.id, name: r.name, exercises: r.exercises.map((x) => ({ exercise_id: x.exercise_id, target: x.target, rest_s: x.rest_s })) })) };
}
export function workoutBody(s: Session, repo: ExerciseRepo): Body {
  return { title: s.title, plan_id: s.plan_id, routine_id: s.routine_id, local_date: s.local_date, started_at: s.started_at, ended_at: s.ended_at,
    exercises: s.exercises.map((x) => ({ id: x.id, exercise_id: x.exercise_id, kind: kindOf(repo.byId(x.exercise_id)), rest_s: x.rest_s, target: x.target,
      sets: x.sets.map((y) => ({ id: y.id, done: y.done, kg: y.kg, reps: y.reps, done_at: y.done_at })) })) };
}
export function habitBody(h: Habit): Body {
  return { name: h.name, short_name: h.short_name, short_name_auto: h.short_name_auto, icon: h.icon, kind: h.kind, target_value: h.target_value, unit: h.unit,
    target_sets: h.target_sets, target_reps: h.target_reps, schedule: h.schedule, weekdays: h.weekdays, starts_on: h.starts_on, position: h.position, archived_at: h.archived_at };
}
export function logBody(l: HabitLog): Body {
  return { id: l.id, value: l.value, done: l.done, target_snapshot: l.target_snapshot, logged_at: l.logged_at };
}
/** every doc on the phone, by key (only finished workouts: the one in progress stays on the phone) */
export function bodies(s: Local, repo: ExerciseRepo): Record<string, Body> {
  const out: Record<string, Body> = {};
  for (const p of s.plans.plans) out[docKey('plan', p.id)] = planBody(p, s.plans.activeId);
  for (const w of s.workouts.sessions) if (w.ended_at) out[docKey('workout', w.id)] = workoutBody(w, repo);
  for (const h of s.habits.habits) out[docKey('habit', h.id)] = habitBody(h);
  for (const l of s.habits.logs) out[logKey(l)] = logBody(l);
  return out;
}
/** What to queue: a PUT for each body that differs from the last one queued, a DELETE for each queued doc that went.
 * Habits go before their logs (a log needs its habit on the server). */
export function diff(cur: Record<string, Body>, sent: Record<string, string>): { key: string; body: Body | null }[] {
  const out: { key: string; body: Body | null }[] = [];
  const rank = (k: string) => KINDS.indexOf(kindOfKey(k));
  for (const key of Object.keys(cur).sort((a, b) => rank(a) - rank(b))) { const j = JSON.stringify(cur[key]); if (sent[key] !== j) out.push({ key, body: cur[key] }); }
  // deletes: logs first, then their habits
  for (const key of Object.keys(sent).sort((a, b) => rank(b) - rank(a))) if (!(key in cur)) out.push({ key, body: null });
  return out;
}

// ---- server -> phone -----------------------------------------------------------------------------------------------
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown) => (typeof v === 'string' ? v : null);
const num = (v: unknown) => (typeof v === 'number' ? v : null);
type R = Record<string, unknown>;
export function planOf(r: DocRow): Plan {
  return { id: str(r.id), name: str(r.name), days: ((r.days as string[]) ?? []).map((d) => d || null),
    routines: ((r.routines as R[]) ?? []).map((x) => ({ id: str(x.id), name: str(x.name),
      exercises: ((x.exercises as R[]) ?? []).map((e) => ({ exercise_id: str(e.exercise_id), target: (e.target as Plan['routines'][0]['exercises'][0]['target']) ?? null, rest_s: num(e.rest_s) ?? 0 })) })),
    created_at: str(r.created_at), updated_at: str(r.updated_at) };
}
export function workoutOf(r: DocRow): Session {
  return { id: str(r.id), title: str(r.title), plan_id: strOrNull(r.plan_id), routine_id: strOrNull(r.routine_id), local_date: str(r.local_date),
    started_at: str(r.started_at), ended_at: strOrNull(r.ended_at), rest: null,
    exercises: ((r.exercises as R[]) ?? []).map((x) => ({ id: str(x.id), exercise_id: str(x.exercise_id), rest_s: num(x.rest_s) ?? 0, target: (x.target as Session['exercises'][0]['target']) ?? null,
      sets: ((x.sets as R[]) ?? []).map((y) => ({ id: str(y.id), done: !!y.done, kg: num(y.kg), reps: num(y.reps), done_at: strOrNull(y.done_at),
        kg_in: num(y.kg) === null ? '' : fmtKg(num(y.kg)!), reps_in: num(y.reps) === null ? '' : String(num(y.reps)) })) })) };
}
export function habitOf(r: DocRow): Habit {
  return { id: str(r.id), name: str(r.name), short_name: str(r.short_name), short_name_auto: !!r.short_name_auto, icon: strOrNull(r.icon), kind: r.kind as Habit['kind'],
    target_value: num(r.target_value), unit: strOrNull(r.unit), target_sets: num(r.target_sets), target_reps: num(r.target_reps), schedule: r.schedule as Habit['schedule'],
    weekdays: num(r.weekdays) ?? 0, starts_on: str(r.starts_on), position: num(r.position) ?? 0, archived_at: strOrNull(r.archived_at), created_at: str(r.created_at), updated_at: str(r.updated_at) };
}
export function logOfRow(r: DocRow): HabitLog {
  return { id: str(r.id), habit_id: str(r.habit_id), local_date: str(r.local_date), value: num(r.value), done: !!r.done,
    target_snapshot: r.target_snapshot as HabitLog['target_snapshot'], logged_at: str(r.logged_at) };
}
const keyOfRow = (kind: DocKind, r: DocRow) => (kind === 'habitLog' ? logKey(logOfRow(r)) : docKey(kind, str(r.id)));

/** put one server row on the phone (replacing the phone's record with that key) */
function put(s: Local, kind: DocKind, r: DocRow): Local {
  switch (kind) {
    case 'plan': {
      const p = planOf(r), plans = s.plans.plans.some((x) => x.id === p.id) ? s.plans.plans.map((x) => (x.id === p.id ? p : x)) : [...s.plans.plans, p];
      const activeId = r.active ? p.id : s.plans.activeId === p.id ? null : s.plans.activeId;
      return { ...s, plans: { ...s.plans, plans, activeId } };
    }
    case 'workout': {
      const w = workoutOf(r), ss = s.workouts.sessions;
      return { ...s, workouts: { ...s.workouts, sessions: ss.some((x) => x.id === w.id) ? ss.map((x) => (x.id === w.id ? w : x)) : [...ss, w] } };
    }
    case 'habit': {
      const h = habitOf(r), hs = s.habits.habits;
      return { ...s, habits: { ...s.habits, habits: hs.some((x) => x.id === h.id) ? hs.map((x) => (x.id === h.id ? h : x)) : [...hs, h] } };
    }
    case 'habitLog': {
      const l = logOfRow(r);
      if (!s.habits.habits.some((h) => h.id === l.habit_id)) return s;
      return { ...s, habits: { ...s.habits, logs: [...s.habits.logs.filter((x) => !(x.habit_id === l.habit_id && x.local_date === l.local_date)), l] } };
    }
  }
}
/** remove the phone's record with this key (a habit takes its logs with it) */
function drop(s: Local, key: string): Local {
  const kind = kindOfKey(key), id = key.slice(kind.length + 1);
  switch (kind) {
    case 'plan': return { ...s, plans: { ...s.plans, plans: s.plans.plans.filter((p) => p.id !== id), activeId: s.plans.activeId === id ? null : s.plans.activeId } };
    case 'workout': return { ...s, workouts: { ...s.workouts, sessions: s.workouts.sessions.filter((w) => w.id !== id) } };
    case 'habit': return { ...s, habits: { ...s.habits, habits: s.habits.habits.filter((h) => h.id !== id), logs: s.habits.logs.filter((l) => l.habit_id !== id) } };
    case 'habitLog': { const [h, d] = id.split('/'); return { ...s, habits: { ...s.habits, logs: s.habits.logs.filter((l) => !(l.habit_id === h && l.local_date === d)) } }; }
  }
}
/** the name to show in a notice */
export function labelOf(s: Local, key: string): string {
  const kind = kindOfKey(key), id = key.slice(kind.length + 1);
  if (kind === 'plan') return s.plans.plans.find((p) => p.id === id)?.name ?? 'Plan';
  if (kind === 'workout') return s.workouts.sessions.find((w) => w.id === id)?.title ?? 'Workout';
  const hid = kind === 'habit' ? id : id.split('/')[0];
  return s.habits.habits.find((h) => h.id === hid)?.short_name ?? 'Habit';
}

/** Changes to the ledger, and the phone's new state, after a flush answered these docs. */
export interface Landing { local: Local; adopt: { key: string; version: number; body: string }[]; forget: string[]; notices: string[] }
export const STALE_REASON = 'Changed on another device. Showing the saved version.';
export const GONE_REASON = 'Deleted on another device.';
export function landResult(s0: Local, r: DocResult, repo: ExerciseRepo): Landing {
  let s = s0;
  const adopt: Landing['adopt'] = [], forget: string[] = [], notices: string[] = [];
  for (const x of r.stale) {
    notices.push(`${labelOf(s, x.key)}: ${x.reason || STALE_REASON}`);
    if (x.row.deleted_at) { s = drop(s, x.key); forget.push(x.key); continue; }
    s = put(s, kindOfKey(x.key), x.row);
    const b = bodies(s, repo)[x.key];
    if (b) adopt.push({ key: x.key, version: x.row.version, body: JSON.stringify(b) });
  }
  for (const key of r.gone) { notices.push(`${labelOf(s, key)}: ${GONE_REASON}`); s = drop(s, key); forget.push(key); }
  for (const f of r.failed) notices.push(`Couldn’t sync ${labelOf(s, f.key)}. ${f.reason || 'The server refused it.'}`);
  return { local: s, adopt, forget, notices };
}

/** A pull (sign-in on this phone, app start): server rows the phone doesn't have come down; a row edited on another
 * device replaces the phone's copy only when the phone has nothing unsent for it; a row the phone synced that the server
 * no longer lists was deleted there. */
export function landPull(s0: Local, rows: Record<DocKind, DocRow[]>, led: Ledger, queued: Set<string>, repo: ExerciseRepo): Landing {
  let s = s0;
  const adopt: Landing['adopt'] = [], forget: string[] = [];
  const mine0 = bodies(s, repo);
  const unsent = (k: string) => queued.has(k) || (k in mine0 && led.sent[k] !== JSON.stringify(mine0[k]));
  const listed = new Set<string>();
  for (const kind of KINDS) for (const r of rows[kind] ?? []) {
    const key = keyOfRow(kind, r); listed.add(key);
    if (unsent(key)) continue;
    if (!(key in mine0) && key in led.sent) continue; // deleted on this phone; its delete is on the way
    if (key in mine0 && (led.v[key] ?? 0) >= r.version) continue;
    s = put(s, kind, r);
    const b = bodies(s, repo)[key];
    if (b) adopt.push({ key, version: r.version, body: JSON.stringify(b) });
  }
  for (const key of Object.keys(mine0)) if (led.v[key] && !listed.has(key) && !unsent(key)) { s = drop(s, key); forget.push(key); }
  return { local: s, adopt, forget, notices: [] };
}
