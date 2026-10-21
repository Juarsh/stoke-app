// Exercises list and how-to page rules (spec §9.2, §9.3): search over name and aliases, one Equipment filter and the
// muscle chips, the results line, the closest matches for a no-result search, the credit line and the muscle legend.
import type { Exercise, ExerciseGroup, ExerciseRepo } from '@/lib/exercises';

export const GROUPS: ('All' | ExerciseGroup)[] = ['All', 'Chest', 'Back', 'Legs', 'Shoulders', 'Arms', 'Core', 'Full body'];
const EQUIPMENT_ORDER = ['Barbell', 'Dumbbell', 'Cable', 'Machine', 'Kettlebell', 'EZ bar', 'Band', 'Pull-up bar', 'Bodyweight'];
/** The Equipment ▾ choices: the ones the library has, in a fixed order. */
export const equipmentOf = (repo: ExerciseRepo) => {
  const have = new Set(repo.all().map((e) => e.equipment));
  return [...EQUIPMENT_ORDER.filter((x) => have.has(x)), ...[...have].filter((x) => !EQUIPMENT_ORDER.includes(x)).sort()];
};
export interface Filters { group: 'All' | ExerciseGroup; equipment: string | null }
export const NO_FILTERS: Filters = { group: 'All', equipment: null };
export const filtered = (f: Filters) => f.group !== 'All' || !!f.equipment;
export const matchesFilters = (e: Exercise, f: Filters) => (f.group === 'All' || e.group === f.group) && (!f.equipment || e.equipment === f.equipment);

/** lower case, punctuation as space, a plural s dropped per word ("Push-Ups" = "push up") */
export const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean).map((w) => w.replace(/(?<=\p{L}{2})s$/u, ''));
/** Ranking tier (lower is better), null when it doesn't match:
 * 0 the name is the query, 1 the name starts with it, 2 every query word starts a word of the name,
 * 3 an alias is or starts with it / every word starts an alias word, 4 the query is inside the name. */
export function rank(e: Exercise, q: string): number | null {
  const qw = words(q); if (!qw.length) return null;
  const qs = qw.join(' ');
  const nw = words(e.name), ns = nw.join(' ');
  if (ns === qs) return 0;
  if (ns.startsWith(qs)) return 1;
  const all = (ws: string[]) => qw.every((w) => ws.some((x) => x.startsWith(w)));
  if (all(nw)) return 2;
  for (const a of e.aliases) { const aw = words(a), as = aw.join(' '); if (as === qs || as.startsWith(qs) || all(aw)) return 3; }
  if (ns.replace(/ /g, '').includes(qs.replace(/ /g, ''))) return 4;
  return null;
}
export function search(repo: ExerciseRepo, q: string, f: Filters = NO_FILTERS): Exercise[] {
  const rows = repo.all().filter((e) => matchesFilters(e, f));
  if (!words(q).length) return [...rows].sort(byName);
  return rows.map((e) => ({ e, r: rank(e, q) })).filter((x): x is { e: Exercise; r: number } => x.r !== null)
    .sort((a, b) => a.r - b.r || byName(a.e, b.e)).map((x) => x.e);
}
const byName = (a: Exercise, b: Exercise) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
/** "Closest in the library" for a search with no match: rows sharing the most query words (two words agree when one starts
 * with the other, or their first 4 letters match), shortest names first, at most n. */
export function closest(repo: ExerciseRepo, q: string, n = 3): Exercise[] {
  const qw = words(q).filter((w) => w.length >= 3);
  if (!qw.length) return [];
  const same = (w: string, x: string) => x.startsWith(w) || (x.length >= 3 && w.startsWith(x)) || (w.length >= 4 && x.slice(0, 4) === w.slice(0, 4));
  const score = (e: Exercise) => qw.filter((w) => words(e.name).some((x) => same(w, x))).length;
  return repo.all().map((e) => ({ e, s: score(e) })).filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || words(a.e.name).length - words(b.e.name).length || byName(a.e, b.e)).slice(0, n).map((x) => x.e);
}
export const metaLine = (e: Exercise) => `${e.group} · ${e.equipment}`;
/** "6 exercises · Back · Cable" */
export const resultsLine = (n: number, f: Filters) => [`${n} ${n === 1 ? 'exercise' : 'exercises'}`, f.group !== 'All' ? f.group : null, f.equipment].filter(Boolean).join(' · ');
const LICENCE_LABEL: Record<string, string> = { 'CC-BY-SA-4.0': 'CC BY-SA 4.0', 'CC-BY-SA-3.0': 'CC BY-SA 3.0' };
export const authorsLabel = (a: string[]) => (a.length <= 1 ? a[0] ?? 'wger.de contributors' : `${a[0]} and ${a.length - 1} ${a.length === 2 ? 'other' : 'others'}`);
/** "Steps adapted from wger.de (author: X), CC BY-SA 4.0"; none for CC0 rows. */
export function creditLine(e: Exercise): string | null {
  const l = LICENCE_LABEL[e.licence];
  if (!l) return null;
  return `Steps ${e.adapted ? 'adapted from' : 'from'} wger.de (author: ${authorsLabel(e.licence_authors)}), ${l}`;
}
export const legend = (e: Exercise) => ({ primary: e.primary_muscles.join(', '), secondary: e.secondary_muscles.join(', ') });
/** TalkBack label for the muscle card ("Muscles worked. Main muscle: Lats. Also works: Triceps, Rear delts."). */
export const muscleLabel = (e: Exercise) => { const l = legend(e); return `Muscles worked. Main muscle: ${l.primary}.${l.secondary ? ` Also works: ${l.secondary}.` : ''}`; };
export const HINT = 'Tap any exercise for a how-to. Your best set shows here once you log it.';
export const DEMO_TITLE = 'Demo coming soon';
export const DEMO_LINE = 'We’re drawing this one. Steps and muscles are below.';

/** Credits (§9.6): every named author of a bundled row, A–Z, and the licence mix. */
export const allAuthors = (repo: ExerciseRepo) =>
  [...new Set(repo.all().flatMap((e) => e.licence_authors))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
export const licenceCounts = (repo: ExerciseRepo) =>
  repo.all().reduce<Record<string, number>>((m, e) => ({ ...m, [e.licence]: (m[e.licence] ?? 0) + 1 }), {});
