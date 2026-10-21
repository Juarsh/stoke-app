// One-off curated wger export (spec §9.7, Q22: 150–250 exercises) -> src/data/exercises.json.
// Every row keeps its wger exercise id, the licence and authors of the text we use, and the data licence. The rules are
// mechanical (no hand-written exercises, no invented text):
// 1. English name; the description has at least 120 characters of text; at least one primary muscle.
// 2. Licence is CC BY-SA 3.0 / 4.0 or CC0 (wger's licences for exercise text); a BY-SA text names its author (the credit
//    line must name one).
// 3. Equipment: wger's list (main item first by MAIN_EQUIPMENT), or, when wger lists none, a word in the name
//    (machine, smith, leg press, pulldown, ...). A row whose equipment can't be told is left out.
// 4. The name is English and not a numbered variant: no word from NON_ENGLISH ("mit", "und", ...), no accented letters,
//    no trailing variant number ("Bear Walk 2"). The next ranked row takes its place.
// 4b. Not a one-sided copy ("… left" / "… right", the other side is the same exercise) and not a stretch (the library is
//    for logged sets).
// 5. One row per normalised name (case, punctuation and a plural s ignored), across names and aliases. Ranked by how many languages wger has it in (a proxy for how common it is), then by
//    image count, then id; the top 250 are kept.
// Steps: the description's numbered list, else the sentences of its first paragraph (max 8), HTML removed; a sentence that
// only introduces the exercise (INTRO: "This exercise …", "X is a …", "… targets …") is dropped, and a row left with fewer
// than 2 steps is skipped. That split is the adaptation
// ("Steps adapted from wger.de"). Names: first letter upper-cased, otherwise as in wger.
import { readFileSync, writeFileSync } from 'node:fs';

const MAX = 250;
const snap = JSON.parse(readFileSync(new URL('./snapshot.json', import.meta.url), 'utf8'));
const LICENCE = { 1: { code: 'CC-BY-SA-3.0', url: 'https://creativecommons.org/licenses/by-sa/3.0/' },
  2: { code: 'CC-BY-SA-4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' }, 3: { code: 'CC0-1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' } };
const DATA_LICENCE = { 'CC-BY-SA 3': 'CC-BY-SA-3.0', 'CC-BY-SA 4': 'CC-BY-SA-4.0', CC0: 'CC0-1.0' };
const GROUP = { Abs: 'Core', Arms: 'Arms', Back: 'Back', Calves: 'Legs', Chest: 'Chest', Legs: 'Legs', Shoulders: 'Shoulders', Cardio: 'Full body' };
const MUSCLE = { 'Obliquus externus abdominis': 'Obliques', 'Serratus anterior': 'Serratus' };
const MAIN_EQUIPMENT = [['Barbell', 'Barbell'], ['SZ-Bar', 'EZ bar'], ['Dumbbell', 'Dumbbell'], ['Kettlebell', 'Kettlebell'], ['Cable machine', 'Cable'],
  ['Resistance band', 'Band'], ['Pull-up bar', 'Pull-up bar'], ['none (bodyweight exercise)', 'Bodyweight'], ['Swiss Ball', 'Bodyweight'],
  ['Gym mat', 'Bodyweight'], ['Bench', 'Bodyweight'], ['Incline bench', 'Bodyweight']];
const BY_NAME = [[/\bsmith\b/i, 'Machine'], [/\bmachine\b|leg press|leg curl|leg extension|pec deck|hack squat|hackenschmidt|belt squat|calf press/i, 'Machine'],
  [/pull ?-?down|cable/i, 'Cable'], [/\bbarbell\b|\bbb\b|trap bar/i, 'Barbell'], [/\bdumbbells?\b|\bdb\b/i, 'Dumbbell'], [/kettlebell/i, 'Kettlebell']];

const text = (h) => h.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&#39;|&rsquo;/g, '’').replace(/\s+/g, ' ').trim();
function steps(html) {
  // an ordered list is the steps; otherwise the sentences of the first paragraph (the how-to; later paragraphs and bullet
  // lists are notes and variations)
  const ol = /<ol[^>]*>([\s\S]*?)<\/ol>/i.exec(html);
  const li = ol ? [...ol[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => text(m[1])).filter((s) => s.length >= 8) : [];
  if (li.length >= 2) return li.filter((x) => !INTRO.test(x)).slice(0, 8);
  const p = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(html);
  return text(p ? p[1] : html).split(/(?<=[.!?])\s+(?=[A-Z0-9“"])/).map((x) => x.trim()).filter((x) => x.length >= 8 && !INTRO.test(x)).slice(0, 8);
}
function equipment(r) {
  for (const [w, label] of MAIN_EQUIPMENT) if (r.equipment.includes(w)) {
    // a bench / mat / ball alone means no load: bodyweight, unless the name says otherwise
    if (label === 'Bodyweight') { const n = BY_NAME.find(([re]) => re.test(r.t.name)); return n ? n[1] : label; }
    return label;
  }
  const n = BY_NAME.find(([re]) => re.test(r.t.name));
  return n ? n[1] : null;
}
const norm = (s) => s.toLowerCase().replace(/[-_]+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();
const key = (s) => norm(s).split(' ').map((w) => w.replace(/(?<=\w\w)s$/, '')).join(' ');
const authorsOf = (r) => [...new Set([...(r.t.author_history ?? []), r.t.license_author].map((a) => (a ?? '').trim()).filter(Boolean))];
const NON_ENGLISH = /\b(mit|und|auf|zum|zur|der|das|ohne|bizeps|trizeps|kurzhantel|langhantel|seitheben|liegend|stehend|sitzend|con|avec|sur|para|sentado)\b|[À-ÿ]/i;
const VARIANT_NO = /\s(\d+|\(\d+\)|v\d+)$/i;
const INTRO = /^(?!(your|make|first|keep|be|ensure|lean|stand|sit|lie|lay|hold|grab|grip|place|put|take|start|begin|bend|step)\b)(?:(this|these)( \w+)? (exercise|movement|is)\b|in this\b|it (can|helps|works|tightens|should not be considered|is (one|a|an|usually))\b|aka\b|purpose\b|works your\b|full-body\b|the procedure\b|[^.:]{0,80}?\b(is|are) (a|an|one|another|the|designed|ideal|great|very|similar|done|performed|known|used)\b|.*\b(targets?|targeting)\b|.*\bexercise (that|which|for|used|in|performed)\b)/i;
const SKIP = /\b(left|right)\b|stretch/i;
const TIME = /\bplank\b|\bhold\b|wall sit|isometric/i;

const seen = new Set();
const cand = snap.rows
  .filter((r) => text(r.t.description).length >= 120 && r.muscles.length && LICENCE[r.t.license] && DATA_LICENCE[r.license.short_name])
  .filter((r) => r.t.license === 3 || authorsOf(r).length > 0)
  .filter((r) => !SKIP.test(r.t.name) && !NON_ENGLISH.test(r.t.name) && !VARIANT_NO.test(r.t.name.trim()))
  .map((r) => ({ r, eq: equipment(r) })).filter((x) => x.eq)
  .sort((a, b) => b.r.n_translations - a.r.n_translations || b.r.n_images - a.r.n_images || a.r.id - b.r.id)
  .filter(({ r }) => steps(r.t.description).length >= 2)
  // unique across names and aliases (§12.6 name_norm): a row whose name is an earlier row's name or alias is the same exercise
  .filter(({ r }) => { const k = key(r.t.name); if (seen.has(k)) return false; seen.add(k); for (const a of r.t.aliases) seen.add(key(a)); return true; })
  .slice(0, MAX);

const names = new Set(cand.map(({ r }) => key(r.t.name))), used = new Set();
const rows = cand.map(({ r, eq }) => {
  const name = r.t.name.trim().replace(/^\p{Ll}/u, (c) => c.toUpperCase());
  const lic = LICENCE[r.t.license];
  const authors = authorsOf(r);
  const primary = [...new Set(r.muscles.map((m) => MUSCLE[m] ?? m))];
  return {
    id: `wger-${r.id}`, name, aliases: r.t.aliases.filter((a) => { const k = key(a); if (!a || k === key(name) || names.has(k) || used.has(k)) return false; used.add(k); return true; }),
    group: GROUP[r.category] ?? 'Full body', equipment: eq,
    primary_muscles: primary, secondary_muscles: [...new Set(r.muscles_secondary.map((m) => MUSCLE[m] ?? m))].filter((m) => !primary.includes(m)),
    type: r.category === 'Cardio' || TIME.test(name) ? 'time' : eq === 'Bodyweight' ? 'bodyweight' : 'weight_reps',
    steps: steps(r.t.description),
    source: 'wger', source_ref: `https://wger.de/exercise/${r.id}/view-base`, wger_id: r.id, wger_translation_id: r.t.id,
    licence: lic.code, licence_url: lic.url, licence_authors: authors, data_licence: DATA_LICENCE[r.license.short_name], data_licence_author: r.license.short_name === 'CC0' ? '' : r.license_author,
    adapted: true, art_origin: null, video_url: null, video_channel: null,
  };
}).sort((a, b) => a.name.localeCompare(b.name));

writeFileSync(new URL('../../src/data/exercises.json', import.meta.url), JSON.stringify({ source: 'wger.de', fetched_at: snap.fetched_at, count: rows.length, rows }, null, 1) + '\n');
console.log(`${rows.length} exercises (from ${snap.rows.length} English wger rows)`);
