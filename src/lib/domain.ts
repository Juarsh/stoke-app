// Pure domain logic (no React / native imports) so it is unit-testable.
import type { Item, OilLevel, Range } from '../parser/parser';

export type Slot = 'breakfast' | 'lunch' | 'snacks' | 'dinner';
export type Diet = 'veg' | 'egg' | 'nonveg';
export type Goal = 'lose' | 'gain' | 'maintain';
/** 'x' = prefer not to say: BMR uses the average of the male (+5) and female (-161) Mifflin-St Jeor constants (-78). */
export type Sex = 'm' | 'f' | 'x';
export const SEX_CONST: Record<Sex, number> = { m: 5, f: -161, x: -78 };
export type EntrySource = 'table' | 'ai' | 'manual' | 'custom';

export interface Profile {
  goal: Goal; sex: Sex; age: number; heightCm: number; weightKg: number;
  activity: 'sedentary' | 'light' | 'moderate' | 'active'; diet: Diet;
  kcalTarget: number; proteinTarget: number; stepsTarget: number; addStepKcal: boolean; showKcalOnCards: boolean;
  /** maintenance kcal (TDEE) from onboarding, sent with the target */
  maintenanceKcal?: number;
}

/**
 * A saved food entry. Numbers are a SNAPSHOT taken at save time and are never
 * recalculated on sync or when the dish table updates; dish_table_version
 * records which table produced them. Only an explicit user edit changes them.
 */
export interface FoodEntry {
  id: string; local_date: string; slot: Slot; raw_text: string;
  dish_id: string | null; custom_name: string; qty: number; unit: string; oil_level: OilLevel;
  kcal: Range; protein_g: Range; carbs_g?: number; fat_g?: number; source: EntrySource; item_source?: string; source_note: string; confirmed: boolean;
  dish_table_version: number; created_at: string; updated_at: string; deleted_at: string | null;
  /** parse span (matched_text). Sent as ItemIn.span when remember=true, so the backend stores it as a Remembered food. */
  span?: string; remember?: boolean;
  /** A pending food that resolved to something uncertain (AI estimate, generic, did-you-mean). Not counted, not synced,
   * until the user confirms review_item in the confirm UI. */
  needs_review?: boolean; review_item?: Item;
  /** server-side placeholder for a pending food (needs_review, no numbers); replaced when the food resolves */
  pending?: boolean;
  /** server refused this save (error.code); the row is back in Review with copy keyed on it */
  reject_code?: string;
  /** the variant the user picked for an ambiguous base dish (sent as variant_dish_id = dish_id) */
  variant_dish_id?: string;
  /** local only: the variant choices the user picked from, so a variant_required rejection can reopen the chips */
  variant_options?: { dish_id: string; name: string; kcal: number; protein_g: number }[];
  /** local only: the 35-minute backstop turned this pending AI row into a failed row (typed kcal only; late answers ignored) */
  ai_expired?: boolean;
  /** local only: why the AI row failed (FailedRow.reason, e.g. 'backstop'); Review shows failedCopy for it */
  ai_fail_reason?: string;
  /** local only: the server's next_reset_at for a cap failure (the cap copy shows it) */
  ai_resets_at?: string;
  /** the server parse job this AI reading came from (sent as parse_job_id; an abandoned job's AI reading is refused) */
  job_id?: string;
  /** the server's row version from its last response for this entry (sent with PATCH; never the phone clock) */
  server_version?: number;
  /** this entry's change could not be synced (error code): its row says "Couldn’t sync this. Tap to retry" */
  sync_error?: string;
  /** the server's reason for that refusal (shown under the retry line), when it gave one */
  sync_reason?: string;
  /** the user tapped retry and that op has not come back yet: the row shows a spinner (never changes what is counted) */
  sync_retrying?: boolean;
  /** rg6 F1: the server saved this row differently from what the phone sent (needs_review, or other qty / unit / kcal). The
   * row now shows the server's version and this readable note says why (Review / Today); cleared by the next user edit. */
  server_note?: string;
  /** rg7 H1: what the server last stored and counts for this row (from its save answer); used while the row is flagged */
  server_counts?: { kcal: number; protein: number };
  /** rg7 H1: the server answered this row's save 5xx three times in a row: flagged ("Couldn’t sync this. Tap to retry") and
   * counted only as the server has it (server_counts, else not at all) until a save goes through */
  server_failed?: boolean;
  /** rg9 B3: the user deleted this row but the server answered 5xx three times: the server still has it, so it stays counted
   * at the server's numbers (server_counts) and flagged ("Not deleted on the server yet.") until a delete gets through */
  delete_failed?: boolean;
  /** rg10: a delete the server refused (4xx other than 404): the row was restored and counts as the server has it */
  kept_on_server?: boolean;
  /** next build: local only. Deleted while an edit to it had not reached the server (still queued, or flagged 5xx): the
   * phone's numbers are that edit, not the server's. If the server refuses the delete, the server's copy comes back and the note names the edit. */
  unsynced_edit?: boolean;
  /** next build (CEO): a refused delete restored this row but the server's copy couldn't be read: its amount is unknown, so
   * it shows "—" (never the phone's unsaved amount) and counts the server's last known numbers until a later read succeeds */
  amount_unknown?: boolean;
}
/** Counted in totals/streak: live and not awaiting review. */
/** live on the server: not deleted, or deleted on the phone but the delete was flagged (rg9 B3: the server still counts it) */
export const onServer = (e: FoodEntry) => !e.deleted_at || !!e.delete_failed;
/** A not-yet-flagged delete is hidden at once (optimistic); a flagged one counts as the server has it. */
export const counted = (e: FoodEntry) => onServer(e) && !e.needs_review;
/** The numbers a counted row adds to the day: the phone's, except a row the server couldn't save (5xx, rg7 H1), which adds
 * what the server has (server-row-is-truth): its last stored numbers, or nothing for a row it never stored. */
export function countedNums(e: FoodEntry): { kcal: number; protein: number } {
  if (e.server_failed || e.delete_failed) return e.server_counts ?? { kcal: 0, protein: 0 };
  return { kcal: e.kcal.best, protein: e.protein_g.best };
}
/** rg8 F-1: a row an older build synced (server_version, no server_counts) and not changed since: what the server has is
 * its numbers as they are now. Recorded before an edit / at load, so a later 5xx flag counts exactly what the server has. */
export function seedServerCounts(e: FoodEntry): FoodEntry {
  if (e.server_counts || e.server_failed || typeof e.server_version !== 'number' || e.deleted_at) return e;
  return { ...e, server_counts: e.needs_review ? { kcal: 0, protein: 0 } : { kcal: e.kcal.best, protein: e.protein_g.best } };
}
/** edge (a): a flagged row (5xx save or delete) the server has stored (it gave a version) but whose numbers the phone doesn't
 * know: an older build's queued edit means the phone's copy isn't the server's, so nothing could be seeded (rg8 F-1). Its
 * server copy is fetched (GET /v1/entries/{id}) so it counts what the server counts instead of 0. */
export const needsServerCopy = (e: FoodEntry) => (!!e.amount_unknown && !e.deleted_at)
  || ((!!e.server_failed || !!e.delete_failed) && !e.server_counts && typeof e.server_version === 'number');
/** Only a confident table match may be saved without the user seeing it. */
export const autoSavable = (it: Item) => it.source === 'table' && !it.needs_confirmation && !it.ai_estimate;
/** Entry awaiting review: placeholder numbers are zero and never shown as a number. */
export function reviewEntry(it: Item, o: { slot: Slot; raw_text: string; local_date: string; tableVersion: number; id: string; now?: Date }): FoodEntry {
  const e = entryFromItem(it, o);
  const z = { low: 0, best: 0, high: 0 };
  return { ...e, kcal: z, protein_g: z, carbs_g: 0, fat_g: 0, confirmed: false, needs_review: true, review_item: it };
}

export const ACTIVITY: Record<Profile['activity'], number> = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725 };

export const MIN_KCAL = 1200;
export const MAX_DEFICIT = 500;
/** Profile as sent to the server: sex is on-device only and never leaves the phone. */
/** PUT /v1/profile payload: target, maintenance, goal, diet, age, height, weight, activity. Never sex. */
export interface ProfilePayload { target_kcal: number; maintenance_kcal: number | null; goal: 'fat_loss' | 'maintain' | 'muscle_gain'; diet: Diet; age: number; height_cm: number; weight_kg: number; activity_level: Profile['activity'] }
const GOAL_API: Record<Goal, ProfilePayload['goal']> = { lose: 'fat_loss', maintain: 'maintain', gain: 'muscle_gain' };
export function profilePayload(p: Profile): ProfilePayload {
  // API.md @ f1fa437 "PUT /v1/profile": the phone's target is stored as sent; the server validates it against MSJ
  return { target_kcal: p.kcalTarget, maintenance_kcal: p.maintenanceKcal ?? null, goal: GOAL_API[p.goal], diet: p.diet,
    age: p.age, height_cm: p.heightCm, weight_kg: p.weightKg, activity_level: p.activity };
}
export function serverProfile(p: Profile): Omit<Profile, 'sex'> { const { sex: _sex, ...rest } = p; return rest; }
/** Mifflin-St Jeor (sex 'x' = average of male/female); lose -400, gain +300 (spec: ±300–500); protein 1.6 g/kg (lose/gain) or 1.2 (maintain). */
export function computeTargets(p: Pick<Profile, 'goal' | 'sex' | 'age' | 'heightCm' | 'weightKg' | 'activity'>) {
  const bmr = 10 * p.weightKg + 6.25 * p.heightCm - 5 * p.age + (SEX_CONST[p.sex] ?? SEX_CONST.x);
  const tdee = bmr * ACTIVITY[p.activity];
  const adj = p.goal === 'lose' ? -400 : p.goal === 'gain' ? 300 : 0;
  // guard rails: a loss goal is never more than MAX_DEFICIT below maintenance; the target never drops below MIN_KCAL
  const raw = Math.max(tdee + adj, tdee - MAX_DEFICIT);
  const kcal = Math.max(MIN_KCAL, Math.round(raw / 10) * 10);
  const protein = Math.round(p.weightKg * (p.goal === 'maintain' ? 1.2 : 1.6));
  return { kcal, protein, maintenance: Math.round(tdee) };
}

/** Spec: before 11 breakfast, 11–4 lunch, 4–7 snacks, after 7 dinner (IST). */
export function slotFor(d: Date): Slot {
  const h = istParts(d).hour;
  return h < 11 ? 'breakfast' : h < 16 ? 'lunch' : h < 19 ? 'snacks' : 'dinner';
}
const IST_MS = 330 * 60 * 1000;
export function istParts(d: Date) {
  const x = new Date(d.getTime() + IST_MS);
  return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, day: x.getUTCDate(), hour: x.getUTCHours() };
}
export function localDate(d: Date = new Date()): string {
  const p = istParts(d);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
export function addDays(date: string, n: number): string {
  const t = Date.parse(date + 'T00:00:00Z') + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
/** Monday of the ISO week containing date (weeks run Mon–Sun IST). */
export function weekStart(date: string): string {
  const dow = (new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7;
  return addDays(date, -dow);
}

export interface StreakState { current: number; best: number; frozenDays: string[]; lastLogged: string | null; freezeJustUsed: boolean }
/**
 * Streak with one AUTOMATIC freeze per Mon–Sun week. A single missed day is
 * covered if that week's freeze is unused; unused freezes don't carry over.
 * `today` not yet logged doesn't break the streak.
 */
export function computeStreak(loggedDates: Iterable<string>, today: string): StreakState {
  const logged = new Set(loggedDates);
  const sorted = [...logged].sort();
  if (sorted.length === 0) return { current: 0, best: 0, frozenDays: [], lastLogged: null, freezeJustUsed: false };
  let best = 0, run = 0, prev: string | null = null;
  const usedWeeks = new Set<string>();
  let frozen: string[] = [];
  const end = logged.has(today) ? today : addDays(today, -1);
  for (let d = sorted[0]; d <= end; d = addDays(d, 1)) {
    if (logged.has(d)) { run++; prev = d; }
    else if (run > 0 && !usedWeeks.has(weekStart(d)) && logged.has(addDays(d, 1)) ) { usedWeeks.add(weekStart(d)); frozen.push(d); }
    else if (run > 0 && !usedWeeks.has(weekStart(d)) && d === end) { usedWeeks.add(weekStart(d)); frozen.push(d); }
    else { run = 0; frozen = []; }
    best = Math.max(best, run);
  }
  const yesterday = addDays(today, -1);
  return { current: run, best, frozenDays: frozen, lastLogged: prev, freezeJustUsed: frozen.includes(yesterday) || frozen.includes(addDays(today, -2)) };
}

/** The text itself named the variant ("veg biryani", typo-confirmed "chiken biryani"): a group dish read
 * without a variant_choice flag. A bare "biryani" always carries variant_choice, so it never counts as a pick. */
let groupOf: ((id: string) => unknown) | null = null;
export function setVariantGroupLookup(f: (id: string) => unknown) { groupOf = f; }
/** parser.unitsFor / dish names (set by src/parser/index.ts, like the variant lookup): the units a table dish can be saved
 * in, from the server's data; null = the phone doesn't have them */
let unitLook: { units: (dishId: string) => string[] | null; name: (dishId: string) => string | undefined } | undefined;
export function setUnitLookup(f: typeof unitLook) { unitLook = f; }
export const unitsKnown = (dishId: string) => !unitLook || unitLook.units(dishId) !== null;
export const unitSupportedFor = (dishId: string, unit: string) => !unitLook || !!unitLook.units(dishId)?.includes(unit);
/** A dish id as words, never a slug: zarda_pulao -> "zarda pulao" (until the dish's own name has arrived). */
export const prettyId = (dishId: string) => dishId.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
export const dishName = (dishId: string) => unitLook?.name(dishId) ?? (dishId ? prettyId(dishId) : 'this dish');
/** THE display name of a food (Today, Review, Log, edit sheet, notes). A dish: the dish table's name (bundled, else
 * pulled), else its id as words (never a slug, and never the typed span: "1 katori kodo khichdi" doubled the amount).
 * Anything else (a custom / typed name): EXACTLY as it came (CEO + Designer, rg8 F-2: 'akarsh_special_shake', 'iPhone shake'). */
export function displayName(name: string | null | undefined, dishId?: string | null): string {
  if (dishId) return unitLook?.name(dishId) ?? prettyId(dishId);
  return name || 'item';
}
/** a row's title: a dish's display name with its first letter capitalised ("Zarda pulao"); any other name as it came */
export const displayLabel = (name: string | null | undefined, dishId?: string | null) => {
  const n = displayName(name, dishId);
  return dishId ? n.charAt(0).toUpperCase() + n.slice(1) : n;
};
/** an entry's title: what the user named it (custom, verbatim), else its dish's display name */
export const entryLabel = (e: { custom_name?: string; dish_id?: string | null }) => (e.custom_name ? e.custom_name : displayLabel('', e.dish_id));
/** Designer (rg6): unit plurals in the 'isn’t measured in' copy */
const PLURAL: Record<string, string> = { katori: 'katoris', spoon: 'spoons', plate: 'plates', gram: 'grams', piece: 'pieces', glass: 'glasses', litre: 'litres' };
export const unitPlural = (unit: string) => PLURAL[unit] ?? (unit.endsWith('s') ? unit : `${unit}s`);
/** "dal isn’t measured in pieces" ('count': "by count") */
export const notMeasured = (dishId: string, unit: string) => `${dishName(dishId)} isn’t measured ${unit === 'count' ? 'by count' : `in ${unitPlural(unit)}`}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** rg6 F1: a table row in a unit the server can't save it in (it would store it needs_review and count nothing) */
/** rg7 E: no unit -> no unit clause (never "isn’t measured in s."). */
export const CHECK_AMOUNT_LINE = 'Check the amount and add it again.';
export const unitReason = (unit: string, dishId = '') => (unit.trim() ? `${cap(notMeasured(dishId, unit))}. Pick another unit.` : CHECK_AMOUNT_LINE);
/** PE: a dish whose units the phone doesn't have yet: not counted until they come down with the dish table */
export const UNITS_UNKNOWN = 'Check amount';
function namedVariant(it: Item): boolean {
  if (!it.dish_id || it.ai_estimate || (it.flags ?? []).includes('variant_choice') || (it as { variant_options?: unknown[] }).variant_options?.length) return false;
  return !!groupOf?.(it.dish_id);
}

/** Build an immutable entry snapshot from a parsed (or edited) item. */
export function entryFromItem(it: Item, o: { slot: Slot; raw_text: string; local_date: string; tableVersion: number; now?: Date; id: string; remember?: boolean }): FoodEntry {
  const now = (o.now ?? new Date()).toISOString();
  return {
    id: o.id, local_date: o.local_date, slot: o.slot, raw_text: o.raw_text,
    dish_id: it.ai_estimate ? null : it.dish_id, custom_name: it.ai_estimate ? it.name : '',
    qty: it.quantity, unit: it.unit, oil_level: it.oil_level,
    kcal: { ...it.kcal }, protein_g: { ...it.protein_g }, carbs_g: it.carbs_g, fat_g: it.fat_g,
    source: it.ai_estimate ? 'ai' : 'table', item_source: it.source, source_note: it.source_note, confirmed: true,
    dish_table_version: o.tableVersion, created_at: now, updated_at: now, deleted_at: null,
    span: it.matched_text, remember: !!o.remember,
    ...(typeof (it as { variant_dish_id?: unknown }).variant_dish_id === 'string' && (it as unknown as { variant_dish_id: string }).variant_dish_id === it.dish_id
      ? { variant_dish_id: it.dish_id } : namedVariant(it) ? { variant_dish_id: it.dish_id } : {}),
    ...(Array.isArray((it as { variant_options_all?: unknown }).variant_options_all) ? { variant_options: (it as unknown as { variant_options_all: FoodEntry['variant_options'] }).variant_options_all } : {}),
  };
}

/** Streak days: anything logged that day counts, even if every item is pending or awaiting review (calories don't). */
export function loggedDays(entries: FoodEntry[], pendingDates: string[] = []): Set<string> {
  return new Set([...entries.filter(onServer).map((e) => e.local_date), ...pendingDates]);
}

/** Placeholder entry for a pending food, synced as needs_review so the server streak matches. */
export function pendingEntry(f: { id: string; span: string; slot: Slot; local_date: string; raw_text: string }, now = new Date()): FoodEntry {
  const z = { low: 0, best: 0, high: 0 }, t = now.toISOString();
  return { id: f.id, local_date: f.local_date, slot: f.slot, raw_text: f.raw_text, dish_id: null, custom_name: f.span, qty: 1, unit: 'count', oil_level: '',
    kcal: z, protein_g: z, source: 'custom', source_note: 'Pending', confirmed: false, dish_table_version: 0, created_at: t, updated_at: t, deleted_at: null,
    span: f.span, needs_review: true, pending: true };
}
/** Items the user can review now (pending placeholders are shown as '— kcal' rows instead). */
/** A review row may be shown with a number / confirmed only when it has a real kcal reading (never 0). */
export const hasKcal = (it?: Item | null) => !!it && Number.isFinite(it.kcal?.best) && it.kcal.best > 0;
export const toReview = (e: FoodEntry) => !e.deleted_at && !!e.needs_review && !e.pending && !!e.review_item;

export function dayTotals(entries: FoodEntry[]) {
  let kcal = 0, protein = 0;
  for (const e of entries) if (counted(e)) { const n = countedNums(e); kcal += n.kcal; protein += n.protein; }
  return { kcal: Math.round(kcal), protein: Math.round(protein * 10) / 10 };
}

/** ~0.04 kcal per step (rough, shown as ≈). */
export const stepsKcal = (steps: number) => Math.round(steps * 0.04);

/** Resolved entries replace same-id entries (the pending placeholder) and append the rest. */
export function mergeEntries(old: FoodEntry[], add: FoodEntry[]): FoodEntry[] {
  const by = new Map(add.map((e) => [e.id, e]));
  const out = old.map((e) => by.get(e.id) ?? e);
  return [...out, ...add.filter((e) => !old.some((o) => o.id === e.id))];
}

/** Plain-English, time-based greeting (v3.2 copy). */
export function greeting(now = new Date()): string {
  const h = Number(now.toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' }));
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}
/** Today's plate: one row per slot (names + kcal), in meal order. */
export function plateRows(entries: FoodEntry[], nameOf: (e: FoodEntry) => string) {
  const order: Slot[] = ['breakfast', 'lunch', 'snacks', 'dinner'];
  return order.map((slot) => {
    const es = entries.filter((e) => e.slot === slot && counted(e));
    return { slot, names: es.map(nameOf).join(', '), kcal: Math.round(es.reduce((a, e) => a + countedNums(e).kcal, 0)), n: es.length };
  });
}

/** A confirmed entry the server refused (e.g. variant without a pick): reopened as an item to review, never counted,
 * with its numbers kept only as the review item's reading so the user confirms or changes it. */
/** Typed kcal (the user's own number): 1 to 5000, like the server. Empty, 0, negatives, NaN and > 5000 are refused. */
export const KCAL_MAX = 5000;
export function validTypedKcal(k: unknown): boolean {
  const n = typeof k === 'string' ? (k.trim() === '' ? NaN : Number(k)) : typeof k === 'number' ? k : NaN;
  return Number.isFinite(n) && n >= 1 && n <= KCAL_MAX;
}
export const TYPED_KCAL_REASON = 'Enter between 1 and 5,000 kcal.';
export const NO_KCAL_REASON = 'This has no calories yet. Check it and add it again.';
/** The source the server sees for this entry (api.ts sends it): custom / ai_estimate / the table item's own source. */
export const serverSource = (e: Pick<FoodEntry, 'source' | 'item_source'>): string =>
  e.source === 'custom' || e.source === 'manual' ? 'custom' : e.source === 'ai' ? 'ai_estimate' : (e.item_source ?? 'table');
/** Quantity range of a table chip (parser.recompute / Go Recompute: > 0 and <= 5000). */
export const QTY_MAX = 5000;
export const qtyInRange = (q: unknown): boolean => typeof q === 'number' && Number.isFinite(q) && q > 0 && q <= QTY_MAX;
/** Smallest amount the edit sheet sets for a unit (its − step). */
export const qtyStep = (unit: string): number => (unit === 'gram' ? 10 : 0.5);
export const amountReason = (unit: string): string => `Enter an amount between ${qtyStep(unit).toLocaleString('en-IN')} and ${QTY_MAX.toLocaleString('en-IN')}.`;
/** Store guard for every saved entry: the server's own rule (food.go resolve), so nothing is refused after it is sent.
 * - typed kcal (custom / manual): 1 to 5000 (TYPED_KCAL_REASON);
 * - a table row (dish_id, not AI): kcal at any size (60 roti = 6,600) but a quantity the table accepts (> 0, <= 5000);
 * - any other computed row (AI estimate x qty, no dish): over 0 and at most 5000 kcal (food.go:969).
 * needs_review entries carry no counted number. Returns why it is refused, or null. The caller keeps a refused row open
 * with this reason: a row is never dropped silently. */
export function entryRefusal(e: FoodEntry): string | null {
  if (e.needs_review || e.pending || e.deleted_at) return null;
  const k = e.kcal?.best;
  const src = serverSource(e);
  if (src === 'custom') return validTypedKcal(k) ? macroReason(e, true) : TYPED_KCAL_REASON;
  const finite = typeof k === 'number' && Number.isFinite(k);
  if (e.dish_id && src !== 'ai_estimate') {
    if (!qtyInRange(e.qty)) return amountReason(e.unit);
    if (!unitsKnown(e.dish_id)) return UNITS_UNKNOWN;
    if (e.unit && !unitSupportedFor(e.dish_id, e.unit)) return unitReason(e.unit, e.dish_id);
    if (!finite || k < 0) return NO_KCAL_REASON;
    return tableTooMuch(e) ? TOO_MUCH_REASON : null;
  }
  if (!finite || k <= 0) return NO_KCAL_REASON;
  // an AI reading (x the amount the user chose) over the server's 5000 / protein 300 per item: too much for one entry
  return limitReason({ kcal: e.kcal, protein_g: e.protein_g, carbs_g: e.carbs_g, fat_g: e.fat_g });
}
/** rg7 H1 (food.go TableKcalMax / TableProteinMax): a table row over 10,000 kcal or 500 g protein for one entry is refused
 * by the server (400); the phone refuses it up front with TOO_MUCH_REASON. */
export const TABLE_KCAL_MAX = 10000;
export const TABLE_PROTEIN_MAX = 500;
export function tableTooMuch(n: Pick<FoodEntry, 'kcal' | 'protein_g'>): boolean {
  const k = n.kcal?.best, p = n.protein_g?.best;
  return (typeof k === 'number' && k > TABLE_KCAL_MAX) || (typeof p === 'number' && p > TABLE_PROTEIN_MAX);
}
/** food.go resolve, custom / AI rows (no table dish): kcal 0-5000, protein_g 0-300, carbs_g and fat_g >= 0. Table rows are
 * recomputed by the server and have no such per-item cap. */
export const PROTEIN_MAX = 300;
/** Designer (Oct 17): an amount change that takes a row past a server limit (AI kcal > 5000, protein > 300). */
export const TOO_MUCH_REASON = 'That’s too much for one entry. Try a smaller amount.';
export const BAD_NUMBERS_REASON = 'These numbers can’t be saved. Check them and try again.';
export const TYPED_PROTEIN_REASON = 'Enter between 0 and 300 g protein.';
const num = (x: unknown, d = 0) => (typeof x === 'number' ? x : d);
function macroReason(e: Pick<FoodEntry, 'protein_g' | 'carbs_g' | 'fat_g'>, typed: boolean): string | null {
  const p = num(e.protein_g?.best), c = num(e.carbs_g), f = num(e.fat_g);
  if (![p, c, f].every(Number.isFinite) || p < 0 || c < 0 || f < 0) return BAD_NUMBERS_REASON;
  return p > PROTEIN_MAX ? (typed ? TYPED_PROTEIN_REASON : TOO_MUCH_REASON) : null;
}
/** A computed (non-table) reading the server would refuse, or null: the edit sheets and the store guard both use it. */
export function limitReason(n: { kcal: Range; protein_g: Range; carbs_g?: number; fat_g?: number }): string | null {
  if (num(n.kcal?.best) > KCAL_MAX) return TOO_MUCH_REASON;
  return macroReason(n, false);
}
/** custom_name as the server takes it: trimmed, at most 120 bytes (Go len), cut at a word boundary (G3). The full text
 * stays in raw_text. */
export const NAME_MAX_BYTES = 120;
const utf8Len = (s: string) => { let n = 0; for (const ch of s) { const c = ch.codePointAt(0)!; n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4; } return n; };
export function serverName(s: string): string {
  const t = (s ?? '').trim();
  if (utf8Len(t) <= NAME_MAX_BYTES) return t;
  let out = '';
  for (const w of t.split(/\s+/)) { const next = out ? `${out} ${w}` : w; if (utf8Len(next) > NAME_MAX_BYTES) break; out = next; }
  if (!out) for (const ch of t) { if (utf8Len(out + ch) > NAME_MAX_BYTES) break; out += ch; } // one very long word
  return out.replace(/[\s,;:.\-–—]+$/u, '') || out;
}
export const savableEntry = (e: FoodEntry): boolean => entryRefusal(e) === null;

export function reopenRejected(e: FoodEntry, code = '', now = new Date(), serverOptions?: FoodEntry['variant_options']): FoodEntry {
  if (serverOptions?.length) e = { ...e, variant_options: serverOptions };
  const it: Item = {
    dish_id: e.dish_id ?? '', name: e.custom_name || (e.dish_id ? unitLook?.name(e.dish_id) ?? e.dish_id : '') || e.raw_text, matched_text: e.span ?? e.raw_text, quantity: e.qty, unit: e.unit, grams: 0,
    oil_level: e.oil_level, kcal: { ...e.kcal }, protein_g: { ...e.protein_g }, carbs_g: e.carbs_g ?? 0, fat_g: e.fat_g ?? 0,
    source: 'did_you_mean', data_source: '', source_note: e.source_note, fuzzy: false, needs_confirmation: true,
    flags: ['server_rejected', ...(code === 'variant_required' ? ['variant_choice'] : code === 'quantity_required' ? ['vague_quantity'] : [])],
    ...(code === 'variant_required' && e.variant_options?.length ? { variant_options: e.variant_options } : {}),
    default_portion: false, span_start: 0, span_end: 0, ai_estimate: e.source === 'ai',
  };
  const z = { low: 0, best: 0, high: 0 };
  // raw_text (what the user typed) is kept as is
  // a note from an earlier state (e.g. 'Check amount' while its units were unknown) never hides this refusal's own line
  return { ...e, kcal: z, protein_g: z, carbs_g: 0, fat_g: 0, confirmed: false, needs_review: true, review_item: it, reject_code: code || 'unknown', server_note: undefined, updated_at: now.toISOString() };
}
