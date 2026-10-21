// Active workout logger (build-plan item 10; full-b2 active-logger, active-logger-finish, active-logger-discard, states #7
// resume banner, #10 bodyweight row, #11 empty workout; workouts notes §3). Pure rules: the session shape kept on the phone,
// starting from a routine or empty, "previous" from the last finished workout, the grey prefill, ticking a set (checked,
// never clamped), the header numbers, and what Finish saves. Only ticked sets are ever saved (Akarsh, 20 Oct).
// kg only, no bodyweight volume (CEO Q1): a bodyweight set counts only its added kg ("BW +10"); timed sets count none.
import type { Exercise, ExerciseRepo } from '@/lib/exercises';
import { dayOf } from '@/lib/domain';
import type { Routine, Target } from '../plans/model';

/** A set: typed text while it's open; numbers only once ticked (done). */
export interface WSet { id: string; kg_in: string; reps_in: string; done: boolean; kg: number | null; reps: number | null; done_at: string | null }
export interface SessionExercise { id: string; exercise_id: string; rest_s: number; target: Target | null; sets: WSet[] }
export interface Session {
  id: string; title: string; plan_id: string | null; routine_id: string | null;
  local_date: string; started_at: string; ended_at: string | null; exercises: SessionExercise[];
  /** the rest timer running in this workout (phone only; never part of a finished workout) */
  rest?: Rest | null;
}
/** Rest timer C (item 11): ends_at in ms; total_s for the ring; the set it is counting down to (null: none left). */
export interface Rest { ends_at: number; total_s: number; ex_id: string; set_id: string | null }
export interface Prefs { vibrate: boolean }
export interface WorkoutsState { v: 1; active: Session | null; sessions: Session[]; prefs: Prefs }
export const EMPTY_WORKOUTS: WorkoutsState = { v: 1, active: null, sessions: [], prefs: { vibrate: true } };

export const KG_MAX = 1000;
export const REPS_MAX = 200;
export const SECS_MAX = 24 * 3600;

export type Kind = 'weight' | 'bodyweight' | 'time';
/** How a set is logged. Pull-up bar / bodyweight equipment logs as bodyweight even where the source row says weight_reps
 * (wger lists Pull-ups as weight_reps), so a pull-up never needs a kg number. */
export const kindOf = (e: Pick<Exercise, 'type' | 'equipment'> | undefined): Kind =>
  e?.type === 'time' ? 'time' : e?.type === 'bodyweight' || e?.equipment === 'Bodyweight' || e?.equipment === 'Pull-up bar' ? 'bodyweight' : 'weight';

// ---- starting -----------------------------------------------------------------------------------------------------
const blankSet = (id: string): WSet => ({ id, kg_in: '', reps_in: '', done: false, kg: null, reps: null, done_at: null });
export function newExercise(exercise_id: string, newId: () => string, sets = 3, rest_s = 90, target: Target | null = null): SessionExercise {
  return { id: newId(), exercise_id, rest_s, target, sets: Array.from({ length: sets }, () => blankSet(newId())) };
}
/** Start from a routine: its exercises in order, the target's number of sets (3 without a target), its rest. */
export function startFromRoutine(r: Routine, planId: string, newId: () => string, now: Date): Session {
  return { id: newId(), title: r.name, plan_id: planId, routine_id: r.id, local_date: dayOf(now), started_at: now.toISOString(), ended_at: null,
    exercises: r.exercises.map((x) => newExercise(x.exercise_id, newId, x.target?.sets ?? 3, x.rest_s, x.target)) };
}
export const startEmpty = (newId: () => string, now: Date): Session =>
  ({ id: newId(), title: 'Empty workout', plan_id: null, routine_id: null, local_date: dayOf(now), started_at: now.toISOString(), ended_at: null, exercises: [] });

// ---- previous + grey prefill ----------------------------------------------------------------------------------------
export interface Prev { kg: number | null; reps: number }
/** The done sets of this exercise in the latest finished workout that has any ("Previous" column, by position). */
export function previousSets(sessions: Session[], exerciseId: string, beforeIso?: string): Prev[] {
  const done = [...sessions].filter((s) => s.ended_at && (!beforeIso || s.started_at < beforeIso)).sort((a, b) => b.started_at.localeCompare(a.started_at));
  for (const s of done) {
    const sets = s.exercises.filter((x) => x.exercise_id === exerciseId).flatMap((x) => x.sets.filter((y) => y.done && y.reps !== null));
    if (sets.length) return sets.map((y) => ({ kg: y.kg, reps: y.reps! }));
  }
  return [];
}
export const fmtKg = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
/** "55 kg × 10", "BW × 8", "BW +10 × 6", "45 s"; "—" when there was none. */
export function prevLabel(p: Prev | undefined, kind: Kind): string {
  if (!p) return '—';
  if (kind === 'time') return `${p.reps} s`;
  if (kind === 'bodyweight') return `BW${p.kg ? ` +${fmtKg(p.kg)}` : ''} × ${p.reps}`;
  return `${p.kg === null ? '—' : fmtKg(p.kg)} kg × ${p.reps}`;
}
/** The grey values in an empty box: last time's set at this position, else the last one of last time, else the target's reps. */
export function ghost(prev: Prev[], i: number, target: Target | null): { kg: string; reps: string } {
  const p = prev[i] ?? prev[prev.length - 1];
  if (p) return { kg: p.kg === null ? '' : fmtKg(p.kg), reps: String(p.reps) };
  return { kg: '', reps: target ? String(target.repsHigh) : '' };
}

// ---- ticking a set (hard gate: refuse with a reason, never clamp) ----------------------------------------------------
const num = (s: string) => { const t = s.trim().replace(',', '.'); return /^\d+(\.\d+)?$/.test(t) ? Number(t) : NaN; };
export type Tick = { ok: true; kg: number | null; reps: number } | { ok: false; reason: string };
/** What ticking ✓ logs: the typed value, or the grey one when the box is empty. */
export function checkSet(kgIn: string, repsIn: string, g: { kg: string; reps: string }, kind: Kind): Tick {
  const kgS = kgIn.trim() || g.kg, repsS = repsIn.trim() || g.reps;
  if (!repsS) return { ok: false, reason: kind === 'time' ? 'Enter the seconds first.' : 'Enter the reps first.' };
  const reps = num(repsS);
  const max = kind === 'time' ? SECS_MAX : REPS_MAX;
  if (!Number.isInteger(reps) || reps < 1 || reps > max) return { ok: false, reason: `${kind === 'time' ? 'Seconds' : 'Reps'} must be a whole number from 1 to ${max.toLocaleString('en-IN')}.` };
  if (!kgS) {
    if (kind === 'weight') return { ok: false, reason: 'Enter the kg first.' };
    return { ok: true, kg: null, reps };
  }
  const kg = num(kgS);
  if (!Number.isFinite(kg) || kg < 0 || kg > KG_MAX) return { ok: false, reason: `kg must be a number from 0 to ${KG_MAX.toLocaleString('en-IN')}.` };
  if (Math.round(kg * 100) !== kg * 100) return { ok: false, reason: 'kg can have at most 2 decimals (like 62.5).' };
  return { ok: true, kg, reps };
}

// ---- numbers ---------------------------------------------------------------------------------------------------------
/** Volume of one done set: kg × reps; bodyweight counts only added kg; timed sets count none. */
export const setVolume = (s: WSet, kind: Kind) => (!s.done || kind === 'time' || s.kg === null || s.reps === null ? 0 : s.kg * s.reps);
export function stats(s: Session, repo: ExerciseRepo) {
  let volume = 0, done = 0, total = 0, reps = 0, started = 0;
  for (const x of s.exercises) {
    const kind = kindOf(repo.byId(x.exercise_id));
    const d = x.sets.filter((y) => y.done);
    total += x.sets.length; done += d.length; if (d.length) started++;
    for (const y of d) { volume += setVolume(y, kind); if (kind !== 'time') reps += y.reps ?? 0; }
  }
  return { volume: Math.round(volume * 100) / 100, done, total, reps, started, exercises: s.exercises.length };
}
export const elapsed = (startedIso: string, now: number) => {
  const sec = Math.max(0, Math.floor((now - Date.parse(startedIso)) / 1000));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
};
export const minutes = (startedIso: string, endMs: number) => Math.max(0, Math.round((endMs - Date.parse(startedIso)) / 60000));
export const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
/** Collapsed done exercise: "3 of 3 sets · 100, 110, 120 kg × 5". */
export function doneLine(x: SessionExercise, kind: Kind): string {
  const d = x.sets.filter((y) => y.done);
  const head = `${d.length} of ${x.sets.length} sets`;
  if (!d.length) return head;
  const sameReps = d.every((y) => y.reps === d[0].reps);
  if (kind === 'weight' && sameReps) return `${head} · ${d.map((y) => fmtKg(y.kg ?? 0)).join(', ')} kg × ${d[0].reps}`;
  return `${head} · ${d.map((y) => prevLabel({ kg: y.kg, reps: y.reps! }, kind)).join(', ')}`;
}

// ---- finishing -----------------------------------------------------------------------------------------------------
export type FinishAsk = { kind: 'discard' } | { kind: 'confirm'; undone: number; total: number } | { kind: 'save' };
/** Finish: nothing ticked → "Discard workout?"; some sets open → "Finish workout?" (N of M not done); else save. */
export function finishAsk(s: Session): FinishAsk {
  const all = s.exercises.flatMap((x) => x.sets);
  const done = all.filter((y) => y.done).length;
  if (!done) return { kind: 'discard' };
  return done < all.length ? { kind: 'confirm', undone: all.length - done, total: all.length } : { kind: 'save' };
}
/** What Finish saves: only ticked sets; exercises with none are dropped; ended_at stamped. Done sets are re-checked. */
export function finished(s: Session, now: Date): Session {
  const exercises = s.exercises.map((x) => ({ ...x, sets: x.sets.filter((y) => y.done && y.reps !== null) })).filter((x) => x.sets.length);
  const { rest: _rest, ...rest } = s; void _rest;
  return { ...rest, ended_at: now.toISOString(), exercises };
}
export function sessionError(s: Session): string | null {
  for (const x of s.exercises) for (const y of x.sets) if (y.done) {
    if (y.reps === null || !Number.isInteger(y.reps) || y.reps < 1 || y.reps > SECS_MAX) return 'A ticked set has no valid reps.';
    if (y.kg !== null && (!(y.kg >= 0) || y.kg > KG_MAX)) return 'A ticked set has a kg outside 0–1,000.';
  }
  return null;
}
export function parseWorkouts(raw: string | null): WorkoutsState {
  if (!raw) return EMPTY_WORKOUTS;
  try {
    const s = JSON.parse(raw);
    if (!s || s.v !== 1 || !Array.isArray(s.sessions)) return EMPTY_WORKOUTS;
    const ok = (x: Session) => x && typeof x.id === 'string' && typeof x.started_at === 'string' && Array.isArray(x.exercises);
    return { v: 1, sessions: (s.sessions as Session[]).filter(ok), active: s.active && ok(s.active) ? s.active : null,
      prefs: { vibrate: s.prefs?.vibrate !== false } };
  } catch { return EMPTY_WORKOUTS; }
}

// ---- rest timer C (item 11) ------------------------------------------------------------------------------------------
/** The set after this one: the next open set of the same exercise, else the first open set of a later exercise, else any. */
export function nextOpenSet(s: Session, exId: string, setId: string): { ex: SessionExercise; i: number } | null {
  const xi = s.exercises.findIndex((x) => x.id === exId);
  if (xi < 0) return null;
  const si = s.exercises[xi].sets.findIndex((y) => y.id === setId);
  const order = [...s.exercises.slice(xi), ...s.exercises.slice(0, xi)];
  for (let k = 0; k < order.length; k++) {
    const x = order[k];
    const from = k === 0 ? si + 1 : 0;
    const i = x.sets.findIndex((y, j) => j >= from && !y.done);
    if (i >= 0) return { ex: x, i };
  }
  const own = s.exercises[xi].sets.findIndex((y) => !y.done);
  return own >= 0 ? { ex: s.exercises[xi], i: own } : null;
}
/** Ticking a set starts its exercise's rest (none when rest is 0) towards the next open set. */
export function restAfter(s: Session, exId: string, setId: string, nowMs: number): Rest | null {
  const x = s.exercises.find((e) => e.id === exId);
  if (!x || x.rest_s <= 0) return null;
  const n = nextOpenSet(s, exId, setId);
  return { ends_at: nowMs + x.rest_s * 1000, total_s: x.rest_s, ex_id: n?.ex.id ?? exId, set_id: n ? n.ex.sets[n.i].id : null };
}
export const restLeft = (r: Rest, nowMs: number) => Math.max(0, Math.ceil((r.ends_at - nowMs) / 1000));
/** −15s / +15s: moves the end; never below now (that is "rest done"); the ring's total grows if needed. */
export function shiftRest(r: Rest, ds: number, nowMs: number): Rest {
  const base = ds > 0 ? Math.max(r.ends_at, nowMs) : r.ends_at; // +15s after rest done counts from now
  const ends_at = Math.max(nowMs, base + ds * 1000);
  return { ...r, ends_at, total_s: Math.max(r.total_s, Math.ceil((ends_at - nowMs) / 1000)) };
}
export const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
/** what a screen reader says for a time (Tester O2): "1 minute 20 seconds", "45 seconds", "2 minutes" */
export function spoken(sec: number): string {
  const m = Math.floor(sec / 60), x = sec % 60;
  const p = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  return m && x ? `${p(m, 'minute')} ${p(x, 'second')}` : m ? p(m, 'minute') : p(x, 'second');
}
/** "Set 2 · 60 kg × 10" for the set the rest counts down to (typed values, else last time's grey ones). */
export function restNextLabel(s: Session, r: Rest, prev: (exerciseId: string) => Prev[], repo: ExerciseRepo): string | null {
  const x = s.exercises.find((e) => e.id === r.ex_id); const i = x?.sets.findIndex((y) => y.id === r.set_id) ?? -1;
  if (!x || i < 0) return null;
  const kind = kindOf(repo.byId(x.exercise_id));
  const g = ghost(prev(x.exercise_id), i, x.target);
  const kg = x.sets[i].kg_in || g.kg, reps = x.sets[i].reps_in || g.reps;
  if (!reps) return `Set ${i + 1}`;
  return `Set ${i + 1} · ${kind === 'weight' ? `${kg || '—'} kg × ${reps}` : prevLabel({ kg: kg ? Number(kg) : null, reps: Number(reps) }, kind)}`;
}
