// Workout summary, history and session detail (build-plan item 12; full-b2 workout-summary, train-history, session-detail).
// Pure helpers over saved sessions (done sets only; see finished()). Dates are log days from dayOf (session.local_date);
// weeks start on Monday like the split. PRs and trends are cut from v1 (CEO), so nothing here ranks against the past.
import { addDays } from '@/lib/domain';
import type { ExerciseRepo } from '@/lib/exercises';
import { weekdayOf } from '../plans/model';
import { fmtKg, Kind, kindOf, Session, SessionExercise, setVolume, WSet } from './model';

const n = (x: number) => Math.round(x).toLocaleString('en-US');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const parts = (date: string) => { const [y, m, d] = date.split('-').map(Number); return { y, m, d }; };
/** "20 Oct" */
export const dayMonth = (date: string) => { const p = parts(date); return `${p.d} ${MON[p.m - 1]}`; };
/** "Tue 20 Oct" */
export const dayLabel = (date: string) => `${DOW[weekdayOf(date)]} ${dayMonth(date)}`;
const hm = (iso: string, ampm: boolean) => {
  const s = new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  return ampm ? s : s.replace(/\s?[AP]M$/, '');
};
const ap = (iso: string) => hm(iso, true).slice(-2);
/** "6:10–7:08 PM" (both halves keep AM/PM when they differ) */
export const timeRange = (s: Session) => {
  if (!s.ended_at) return hm(s.started_at, true);
  return ap(s.started_at) === ap(s.ended_at) ? `${hm(s.started_at, false)}–${hm(s.ended_at, true)}` : `${hm(s.started_at, true)}–${hm(s.ended_at, true)}`;
};
export const durationMin = (s: Session) => Math.max(0, Math.round((Date.parse(s.ended_at ?? s.started_at) - Date.parse(s.started_at)) / 60000));

const done = (x: SessionExercise) => x.sets.filter((y) => y.done);
export const exVolume = (x: SessionExercise, kind: Kind) => Math.round(done(x).reduce((a, y) => a + setVolume(y, kind), 0) * 100) / 100;
/** Best set of an exercise: heaviest (added) kg, then most reps; timed = longest hold. */
export function bestSet(x: SessionExercise, kind: Kind): WSet | null {
  const d = done(x); if (!d.length) return null;
  return d.reduce((b, y) => {
    if (kind === 'time') return (y.reps ?? 0) > (b.reps ?? 0) ? y : b;
    const ky = y.kg ?? 0, kb = b.kg ?? 0;
    return ky > kb || (ky === kb && (y.reps ?? 0) > (b.reps ?? 0)) ? y : b;
  });
}
/** "120 kg × 5", "BW × 12", "BW + 10 kg × 8", "60 s" */
export function setLabel(y: WSet, kind: Kind): string {
  if (kind === 'time') return `${y.reps ?? 0} s`;
  if (kind === 'bodyweight') return y.kg ? `BW + ${fmtKg(y.kg)} kg × ${y.reps}` : `BW × ${y.reps}`;
  return `${fmtKg(y.kg ?? 0)} kg × ${y.reps}`;
}
/** session-detail's compact line: "80×6 · 80×6 · 77.5×7"; bodyweight "BW×12 · +10×8"; timed "60s · 45s" */
export function setsLine(x: SessionExercise, kind: Kind): string {
  return done(x).map((y) => (kind === 'time' ? `${y.reps}s` : kind === 'bodyweight' ? (y.kg ? `+${fmtKg(y.kg)}×${y.reps}` : `BW×${y.reps}`) : `${fmtKg(y.kg ?? 0)}×${y.reps}`)).join(' · ');
}
export const setsCount = (k: number) => `${k} ${k === 1 ? 'set' : 'sets'}`;
/** Summary row right side: "3 sets · best 120 kg × 5" */
export function bestLine(x: SessionExercise, kind: Kind): string {
  const b = bestSet(x, kind);
  return b ? `${setsCount(done(x).length)} · best ${setLabel(b, kind)}` : setsCount(0);
}
/** History card's "Top set: Bench Press 80 kg × 6" — the heaviest weighted set of the session (none for BW/time only). */
export function topSet(s: Session, repo: ExerciseRepo): string | null {
  let best: { name: string; y: WSet } | null = null;
  for (const x of s.exercises) {
    const e = repo.byId(x.exercise_id);
    if (kindOf(e) !== 'weight') continue;
    const y = bestSet(x, 'weight');
    if (y && (!best || (y.kg ?? 0) > (best.y.kg ?? 0) || ((y.kg ?? 0) === (best.y.kg ?? 0) && (y.reps ?? 0) > (best.y.reps ?? 0)))) best = { name: e?.name ?? 'Exercise', y };
  }
  return best ? `${best.name} ${setLabel(best.y, 'weight')}` : null;
}
export const fmtVolume = (v: number) => `${n(v)} kg`;

/** Newest first. */
export const byNewest = (ss: Session[]) => [...ss].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
export const weekStart = (date: string) => addDays(date, -weekdayOf(date));
/** "12–18 Oct", or "29 Sep–5 Oct" across months */
export function weekRange(monday: string) {
  const sun = addDays(monday, 6), a = parts(monday), b = parts(sun);
  return a.m === b.m ? `${a.d}–${b.d} ${MON[b.m - 1]}` : `${dayMonth(monday)}–${dayMonth(sun)}`;
}
export const workoutsCount = (k: number) => `${k} ${k === 1 ? 'workout' : 'workouts'}`;
export type HistoryGroup = { key: string; title: string; sessions: Session[] };
/** "This week", then "12–18 Oct · 5 workouts" per earlier week. */
export function historyGroups(ss: Session[], today: string): HistoryGroup[] {
  const thisWeek = weekStart(today); const out: HistoryGroup[] = [];
  for (const s of byNewest(ss)) {
    const k = weekStart(s.local_date);
    let g = out.find((x) => x.key === k);
    if (!g) { g = { key: k, title: '', sessions: [] }; out.push(g); }
    g.sessions.push(s);
  }
  for (const g of out) g.title = g.key === thisWeek ? 'This week' : `${weekRange(g.key)} · ${workoutsCount(g.sessions.length)}`;
  return out;
}
/** Header right: "33 since 24 Aug" */
export function sinceLine(ss: Session[]): string | null {
  if (!ss.length) return null;
  const first = ss.reduce((a, s) => (s.local_date < a ? s.local_date : a), ss[0].local_date);
  return `${ss.length} since ${dayMonth(first)}`;
}
/** Filter chips: All + the workout titles, most frequent first (max 4); hidden with fewer than 2 titles. */
export function titleChips(ss: Session[]): string[] {
  const c = new Map<string, number>();
  for (const s of ss) c.set(s.title, (c.get(s.title) ?? 0) + 1);
  if (c.size < 2) return [];
  return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 4).map(([k]) => k);
}
/** Home chip: sessions on the last 7 log days including today. */
export const weekCount = (ss: Session[], today: string) => { const from = addDays(today, -6); return ss.filter((s) => s.local_date >= from && s.local_date <= today).length; };
/** Last saved session of a routine (Train split "Last 14 Oct", Today's card "Last time"). */
export const lastOf = (ss: Session[], routineId: string) => byNewest(ss.filter((s) => s.routine_id === routineId))[0] ?? null;
/** Train split tick: that routine was saved on the given log day. */
export const doneOn = (ss: Session[], routineId: string, date: string) => ss.some((s) => s.routine_id === routineId && s.local_date === date);
/** Date of weekday i (Mon = 0) in the week of `date`. */
export const weekDate = (date: string, i: number) => addDays(weekStart(date), i);
/** Today's card: "Last time: Tue 13 Oct · 56 min · 6,900 kg" */
export const lastTimeLine = (s: Session, volume: number) => `Last time: ${dayLabel(s.local_date)} · ${durationMin(s)} min · ${fmtVolume(volume)}`;
/** Summary protein nudge: "Protein: 44 of 82 g today. A meal with about 25 g helps recovery." / goal met. */
export function proteinNudge(eaten: number, target: number): string {
  const e = Math.round(eaten), g = Math.round(target);
  if (g <= 0) return 'A meal with about 25 g of protein helps recovery.';
  if (e >= g) return `Protein: ${e} of ${g} g today. You’ve hit your protein goal.`;
  return `Protein: ${e} of ${g} g today. A meal with about ${Math.min(25, Math.max(10, Math.round((g - e) / 5) * 5))} g helps recovery.`;
}
