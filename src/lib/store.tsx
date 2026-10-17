import * as Crypto from 'expo-crypto';
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { abandonedEntry, dropLate, dropLateOps, expirePending, stampPending } from './aiBackstop';
import { AiQuota, countAi, EMPTY_QUOTA, noteReset } from './aiQuota';
import type { ThemePref } from '../theme';
import { fromRows, Learned, Reading } from './learned';
import { createApi, type DishUnits, type ServerRow } from './api';
import { entryFromItem, entryRefusal, hasKcal, FoodEntry, mergeEntries, needsServerCopy, NO_KCAL_REASON, pendingEntry, Profile, profilePayload, reopenRejected, seedServerCounts, serverName, TYPED_KCAL_REASON, validTypedKcal } from './domain';
import { DISH_TABLE_VERSION, Item, parser } from '../parser';
import { adoptServer, holdForUnits, needsUnits, UNITS_HELD } from './serverRow';
import { kv } from './kv';
import { portionLabel } from './labels';
import { fillPending, resolvePending } from './pending';
import { canConfirm } from './confirmBatch';
import { enqueue, flush, FlushResult, hasDue, nextDueAt, Op, PendingFood, SERVER_ERROR } from './syncQueue';

export interface User { id: string; name: string; email: string; idToken: string | null; mock: boolean }
export interface Challenge { code: string; title: string; startDate: string; members: { name: string; days: number }[] }
interface Persisted {
  /** server refused the profile (error.code): onboarding reopens with the values kept */
  profileError?: string | null;
  user: User | null; profile: Profile | null; entries: FoodEntry[]; steps: Record<string, number>;
  queue: Op[]; themePref: ThemePref; challenge: Challenge | null;
  /** the app's own per-user AI count; resets at the server's next_reset_at */
  aiQuota: AiQuota; learned: Learned;
  /** PE: supported units per dish pulled with the server's dish table (the bundled table's are only the start) */
  dishUnits?: DishUnits | null;
}
const EMPTY: Persisted = { profileError: null, user: null, profile: null, entries: [], steps: {}, queue: [], themePref: 'system', challenge: null, aiQuota: EMPTY_QUOTA, learned: {} };
const KEY = 'app-state-v1';
/** 35-minute AI backstop on the whole state (same object back when nothing is due, so no re-render loop). */
/** The phone's entry is still the one that op sent (the user has not changed it since). */
export const DELETED_ELSEWHERE = 'This entry was deleted on another device.';
export type Refused = { id: string; reason: string };
export const CHOOSE_FIRST_REASON = 'Choose the type or amount first.';
/** A review entry confirmed with this item, or why not (the row stays in Review with the reason). */
function confirmedFromReview(old: FoodEntry, it: Item): { entry?: FoodEntry; reason?: string } {
  // never confirm 0 kcal, an unpicked variant/portion/unit, or a placeholder
  if (!canConfirm(it)) return { reason: CHOOSE_FIRST_REASON };
  if (!hasKcal(it)) return { reason: NO_KCAL_REASON };
  const n = { ...entryFromItem({ ...it, needs_confirmation: false }, { id: old.id, slot: old.slot, raw_text: old.raw_text, local_date: old.local_date, tableVersion: DISH_TABLE_VERSION, remember: !!it.dish_id }),
    ...(old.server_version ? { server_version: old.server_version } : {}),
    // an AI reading keeps its job, so a late AI save for an abandoned job is refused (job_abandoned), never counted
    ...(old.job_id && it.ai_estimate ? { job_id: old.job_id } : {}) };
  const reason = entryRefusal(n);
  return reason ? { reason } : { entry: n };
}
const opId = (o: Op) => (o.kind === 'upsert' ? o.entry.id : (o as { id: string }).id);
const unchangedSince = (cur: FoodEntry | undefined, sent: FoodEntry) => !!cur && cur.updated_at === sent.updated_at && !cur.deleted_at;
/** After a flush: server versions recorded (a synced entry loses its sync error); refused / failed ops are handled ONLY when
 * the user has not changed the entry since it was sent, so a refusal never swallows a later typed value. Pure (testable). */
export function applyFlush<P extends { entries: FoodEntry[]; queue: Op[] }>(p: P, sent: Op[], r: Pick<FlushResult, 'rest' | 'resolved' | 'rejected' | 'versions' | 'failed' | 'gone'> & Pick<Partial<FlushResult>, 'rows' | 'kept'>): P {
  const now = new Date();
  // deleted on another device (a save got 404): the delete wins. The local row is dropped (a tombstone: not counted, not
  // shown, no sync error) and every op still queued for it goes, so nothing re-creates or retries it.
  const gone = new Set(r.gone ?? []);
  if (gone.size) {
    const at = now.toISOString();
    const q = { ...p, entries: p.entries.map((x) => (gone.has(x.id) ? { ...x, deleted_at: x.deleted_at ?? at, sync_error: undefined, sync_reason: undefined, sync_retrying: undefined } : x)) };
    const keep = (o: Op) => !gone.has(opId(o));
    return applyFlush({ ...q, queue: q.queue.filter(keep) }, sent, { ...r, gone: [], rest: r.rest.filter(keep),
      rejected: r.rejected.filter((x) => !gone.has(x.entry.id)), failed: r.failed.filter((f) => !gone.has(f.id)) });
  }
  const live = (e: FoodEntry) => p.entries.find((x) => x.id === e.id);
  const reopened = r.rejected.filter((x) => unchangedSince(live(x.entry), x.entry))
    // job_abandoned: the AI reading is refused for good; the row goes back to the failed row (typed kcal only)
    .map((x) => (x.code === 'job_abandoned' ? abandonedEntry(x.entry, now) : reopenRejected(x.entry, x.code, now, x.variant_options)));
  const failed = new Map(r.failed.filter((f) => { const cur = p.entries.find((x) => x.id === f.id); return !f.sent || unchangedSince(cur, f.sent); }).map((f) => [f.id, f]));
  // ops added (or coalesced, e.g. the backstop's row or the user's typed kcal) while we were sending stay queued after the
  // remaining ones and replace their same-id op; a late result for a job the backstop converted is ignored (dropLate / dropLateOps)
  const queue = dropLateOps(reopened.reduce((q, e) => enqueue(q, { kind: 'upsert', entry: e, tries: 0 }), p.queue.filter((o) => !sent.includes(o)).reduce((q, o) => enqueue(q, o), r.rest)), p.entries);
  const kept = new Map((r.kept ?? []).map((k) => [k.id, k]));
  const failedIds = new Set([...r.failed.map((f) => f.id), ...kept.keys()]);
  const deletedOk = new Set(sent.filter((o) => o.kind === 'delete' && !r.rest.includes(o) && !r.rest.some((x) => x.kind === 'delete' && x.id === (o as { id: string }).id) && !failedIds.has((o as { id: string }).id)).map((o) => (o as { id: string }).id));
  const entries = mergeEntries(p.entries, dropLate(p.entries, r.resolved)).map((x) => {
    let n = reopened.find((e) => e.id === x.id) ?? x;
    const v = r.versions[x.id];
    if (typeof v === 'number') n = { ...n, server_version: v, ...(n.sync_error && !failed.has(x.id) ? { sync_error: undefined, sync_reason: undefined } : {}) };
    // what the server now stores and counts for this row (rg7 H1): its own copy, else (older servers) what was sent
    const ok = r.rows?.[x.id];
    if (ok && !failed.has(x.id)) {
      const sr = ok.row, rev = sr.state ? sr.state === 'needs_review' : !!ok.sent.needs_review;
      n = { ...n, server_failed: undefined, server_counts: rev ? { kcal: 0, protein: 0 } : { kcal: sr.kcal_best ?? ok.sent.kcal.best, protein: sr.protein_best ?? ok.sent.protein_g.best } };
    } else if (typeof v === 'number' && !failed.has(x.id) && n.server_failed) n = { ...n, server_failed: undefined };
    const f = failed.get(x.id);
    if (f) n = { ...n, sync_error: f.code, sync_reason: f.reason, ...(f.options?.length ? { variant_options: f.options } : {}), ...(f.code === SERVER_ERROR ? { server_failed: true } : {}),
      ...(f.code === SERVER_ERROR && n.deleted_at && !f.sent ? { delete_failed: true } : {}) };
    // rg9 B3: the delete got through (sent, not failed, not still queued): the row is gone on the server too
    if (!f && n.deleted_at && deletedOk.has(x.id)) n = { ...n, delete_failed: undefined, server_failed: undefined, server_counts: undefined, sync_error: undefined, sync_reason: undefined };
    // rg6 F1: the server stored this save differently (needs_review, or other numbers / amount): the row shows the server's
    // version, so the phone counts exactly what the server counts. Only when the user hasn't changed it since it was sent.
    const sv = r.rows?.[x.id];
    if (sv && !f && !reopened.some((e) => e.id === x.id) && unchangedSince(x, sv.sent)) n = adoptServer(n, sv.row);
    // rg10: the server refused the delete (4xx other than 404): it still has the row, so the phone has it too
    const k = kept.get(x.id);
    if (k && n.deleted_at) n = restoreKept(n, k);
    // retry spinner: done once that row's op has come back (failed again -> sync_error above, else synced)
    if (n.sync_retrying && (failed.has(x.id) || !queue.some((o) => opId(o) === x.id))) n = { ...n, sync_retrying: undefined };
    return n;
  });
  return { ...p, queue, entries };
}

/** rg10: copy on a row whose delete the server refused; the server's own readable reason follows it when it sent one */
export const KEPT_COPY = 'Not deleted: the server kept this entry.';
const sentence = (s: string) => { const t = s.trim(); return t ? (/[.!?]$/.test(t) ? t : `${t}.`).replace(/^./, (c) => c.toUpperCase()) : ''; };
export const keptNote = (reason?: string) => (reason && sentence(reason) ? `${KEPT_COPY} ${sentence(reason)}` : KEPT_COPY);
/** rg10: a delete the server refused: the row is live again (no deleted_at, no delete op), counted at the server's numbers
 * (its copy when the refusal carried one, else server_counts, else the row as the server last confirmed it) and it says why.
 * Edit / delete work on it as on any row. Pure. */
/** next build (CEO, Oct 17): on a refused delete, the edit the delete had replaced (the server never got it) is never re-sent;
 * the row goes back to the server's copy and this note follows the server's reason. */
export const editNotSaved = (what: string) => `Your change to ${what} wasn’t saved. Edit it again if you still want it.`;
const editWhat = (e: FoodEntry) => (e.dish_id ? portionLabel(e.qty, e.unit) : `${Math.round(e.kcal.best).toLocaleString('en-IN')} kcal`);
/** the row as the server's copy has it: its amount and numbers (what it counts), its version */
function serverCopy(n: FoodEntry, row: ServerRow): FoodEntry {
  const rev = row.state === 'needs_review';
  const k = row.kcal_best ?? n.kcal.best, p = row.protein_best ?? n.protein_g.best;
  const shown: FoodEntry = rev ? n : { ...n, dish_id: n.dish_id ? row.dish_id ?? n.dish_id : n.dish_id, qty: row.qty ?? n.qty, unit: row.unit ?? n.unit,
    kcal: { low: row.kcal_low ?? k, best: k, high: row.kcal_high ?? k }, protein_g: { low: row.protein_low ?? p, best: p, high: row.protein_high ?? p },
    carbs_g: row.carbs_g ?? n.carbs_g, fat_g: row.fat_g ?? n.fat_g };
  return { ...(rev ? adoptServer(n, row) : shown), ...(typeof row.version === 'number' ? { server_version: row.version } : {}), server_failed: undefined,
    server_counts: rev ? { kcal: 0, protein: 0 } : { kcal: k, protein: p } };
}
export function restoreKept(e: FoodEntry, k: NonNullable<FlushResult['kept']>[number]): FoodEntry {
  let n: FoodEntry = { ...e, deleted_at: null, delete_failed: undefined, sync_error: undefined, sync_reason: undefined, sync_retrying: undefined, kept_on_server: true, unsynced_edit: undefined };
  // next build (rg10 note 1, CEO Oct 17): the delete had replaced an edit the server never got (queued, or flagged 5xx). It is
  // never re-sent and never dropped silently: the row ALWAYS goes back to the server's copy (qty, unit and numbers: shown ==
  // counted) and the note names the change that wasn't saved.
  if (k.edited || e.unsynced_edit) {
    const copy = k.row && k.row.state ? k.row : undefined;
    const note = `${keptNote(k.reason)} ${editNotSaved(editWhat(e))}`;
    if (copy) return { ...serverCopy(n, copy), server_note: note };
    // the server's copy couldn't be read (GET failed): counted as the server last had it (server_counts; nothing if unknown),
    // flagged, and the amount shows "—" (amount_unknown) until a later read brings the server's qty, unit and numbers
    return { ...n, server_failed: true, amount_unknown: true, server_note: note };
  }
  if (k.row && k.row.state) {
    const rev = k.row.state === 'needs_review';
    n = { ...adoptServer(n, k.row), ...(typeof k.row.version === 'number' ? { server_version: k.row.version } : {}), server_failed: undefined,
      server_counts: rev ? { kcal: 0, protein: 0 } : { kcal: k.row.kcal_best ?? n.kcal.best, protein: k.row.protein_best ?? n.protein_g.best } };
  } else {
    const sc = n.server_counts ?? (typeof n.server_version === 'number' && !n.needs_review ? { kcal: n.kcal.best, protein: n.protein_g.best } : undefined);
    const differs = !!sc && (Math.abs(sc.kcal - n.kcal.best) > 0.5 || Math.abs(sc.protein - n.protein_g.best) > 0.05);
    n = { ...n, server_counts: sc, server_failed: differs ? true : undefined };
  }
  return { ...n, server_note: keptNote(k.reason) };
}

/** edge (a): the server's current copy of flagged rows whose server numbers the phone didn't know (needsServerCopy), fetched
 * after a flush. A copy: the row counts exactly that (server_counts; needs_review = 0) and stays flagged, so the difference
 * from the phone's own value is shown, never counted silently. null (404) on a flagged delete: the server no longer has the
 * row, so the delete won (flag cleared, its queued delete dropped). Anything else, or a row no longer in that state: unchanged.
 * Pure (testable). */
export function applyServerCopies<P extends { entries: FoodEntry[]; queue: Op[] }>(p: P, got: Record<string, ServerRow | null>): P {
  let changed = false; const won = new Set<string>();
  const entries = p.entries.map((e) => {
    if (!(e.id in got) || !needsServerCopy(e)) return e;
    const row = got[e.id];
    // next build: a restored row whose amount was unknown: now the server's row (qty, unit, numbers; shown == counted), note kept.
    // 404: the server no longer has it (deleted elsewhere): gone here too
    if (e.amount_unknown) {
      if (row === null) { changed = true; won.add(e.id); return { ...e, deleted_at: new Date().toISOString(), amount_unknown: undefined, server_failed: undefined, server_counts: undefined, server_note: undefined, kept_on_server: undefined }; }
      if (!row || typeof row !== 'object' || !row.state) return e;
      changed = true;
      return { ...serverCopy(e, row), amount_unknown: undefined };
    }
    if (row === null) {
      if (!e.deleted_at || !e.delete_failed) return e;
      changed = true; won.add(e.id);
      return { ...e, delete_failed: undefined, server_failed: undefined, server_counts: undefined, sync_error: undefined, sync_reason: undefined, sync_retrying: undefined };
    }
    if (!row || typeof row !== 'object') return e;
    changed = true;
    const rev = row.state === 'needs_review';
    return { ...e, server_counts: rev ? { kcal: 0, protein: 0 } : { kcal: row.kcal_best ?? 0, protein: row.protein_best ?? 0 } };
  });
  if (!changed) return p;
  return { ...p, entries, queue: won.size ? p.queue.filter((o) => !((o.kind === 'delete' || o.kind === 'upsert') && won.has(opId(o)))) : p.queue };
}

export function expireState<P extends { entries: FoodEntry[]; queue: Op[] }>(p: P, now = Date.now()): P {
  const r = expirePending(p.entries, p.queue, now);
  return r.converted.length ? { ...p, entries: r.entries, queue: r.queue } : p;
}

function useStoreValue() {
  const [s, setS] = useState<Persisted>(EMPTY);
  const [ready, setReady] = useState(false);
  const tokenRef = useRef<string | null>(null);
  tokenRef.current = s.user?.idToken ?? null;
  // every server response with next_reset_at keeps the app's own AI count on the server's reset instant
  // rg7 B4: a response says the server's dish table is newer than the phone's -> pull it (units, names, version)
  const onTableVersion = useRef<(v: number) => void>(() => {});
  const api = useMemo(() => createApi(() => tokenRef.current, (iso) => setS((p) => { const q = noteReset(p.aiQuota, iso); return q === p.aiQuota ? p : { ...p, aiQuota: q }; }),
    (v) => onTableVersion.current(v)), []);
  const pulling = useRef(false);
  const unitsVersion = useRef(0);
  unitsVersion.current = Math.max(unitsVersion.current, s.dishUnits?.version ?? 0);
  const pullUnits = useCallback(async () => {
    if (pulling.current) return;
    pulling.current = true;
    try {
      const t = await (api.getDishUnits?.() ?? Promise.resolve(null)).catch(() => null);
      if (t) { parser.setPulledUnits(t.units, t.version, t.names); unitsVersion.current = t.version; setS((p) => ({ ...p, dishUnits: t })); }
    } finally { pulling.current = false; }
  }, [api]);
  onTableVersion.current = (v) => { if (v > Math.max(unitsVersion.current, DISH_TABLE_VERSION)) void pullUnits(); };

  useEffect(() => {
    kv.get(KEY).then((raw) => {
      if (!raw) return;
      const p: Persisted = { ...EMPTY, ...JSON.parse(raw) };
      // rows an older build synced and nothing is queued for: the server has them as they are (rg8 F-1)
      const entries = p.entries.map((e) => (p.queue.some((o) => opId(o) === e.id) ? e : seedServerCounts(e)));
      setS(expireState({ ...p, entries, queue: stampPending(p.queue, entries) })); // older queues get a start time; app start runs the backstop
    }).finally(() => setReady(true));
  }, []);
  /** Backstop: app start, foreground, before each sync (the job poll) and on the Log / Review timer. */
  const expireAi = useCallback(() => setS((p) => expireState(p)), []);
  useEffect(() => {
    const sub = AppState.addEventListener?.('change', (a) => { if (a === 'active') expireAi(); });
    return () => sub?.remove?.();
  }, [expireAi]);
  useEffect(() => { if (ready) kv.set(KEY, JSON.stringify(s)).catch(() => {}); }, [s, ready]);

  const sender = useMemo(() => ({
    putProfile: api.putProfile, abandonJob: api.abandonJob,
    // the newest server version known for this entry (an op queued before the last flush carries an older one)
    upsertEntry: (e: FoodEntry) => { const v = entriesRef.current.find((x) => x.id === e.id)?.server_version; return api.upsertEntry(v && v > (e.server_version ?? 0) ? { ...e, server_version: v } : e); }, deleteEntry: api.deleteEntry, getEntry: api.getEntry, deleteRemembered: api.deleteRemembered,
    resolvePending: (f: PendingFood) => resolvePending(api, f),
  }), [api]);
  /** One-time notice (not persisted), e.g. "This entry was deleted on another device." */
  const [notice, setNotice] = useState<string | null>(null);
  const dismissNotice = useCallback(() => setNotice(null), []);
  const syncing = useRef(false);
  const entriesRef = useRef(s.entries);
  useEffect(() => { entriesRef.current = s.entries; }, [s.entries]);
  /** edge (a): fetch the server's copy of these rows (GET /v1/entries/{id}) and count them as it has them (applyServerCopies).
   * A failed GET (offline, 5xx) leaves the row as it was ("not counted") until the next sync or a retry. */
  const fillServerCopies = useCallback(async (ids: string[]) => {
    const got: Record<string, ServerRow | null> = {};
    for (const id of [...new Set(ids)]) { try { got[id] = await api.getEntry(id); } catch { /* unknown: unchanged */ } }
    if (Object.keys(got).length) setS((p) => applyServerCopies(p, got));
  }, [api]);
  // app start: flagged rows saved by an older build whose server numbers were never known (their ops are off the queue)
  useEffect(() => {
    if (!ready || !s.user || api.mock) return;
    const ids = entriesRef.current.filter(needsServerCopy).map((e) => e.id);
    if (ids.length) void fillServerCopies(ids);
  }, [ready, s.user?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const sync = useCallback(async () => {
    if (api.mock || syncing.current) return; // mock mode: nothing leaves the device; queue is kept for later
    // job poll: anything past the 35-minute cutoff is converted first (the queue change re-runs sync without its poll)
    if (expirePending(entriesRef.current, s.queue).converted.length) { expireAi(); return; }
    // next build: restored rows whose amount is unknown ("—"): read the server's copy on every sync, due ops or not
    const unknown = entriesRef.current.filter((e) => e.amount_unknown && !e.deleted_at).map((e) => e.id);
    if (unknown.length) await fillServerCopies(unknown);
    // head still in its backoff (offline): the headAt timer wakes us. Flushing now would only rewrite the queue, which
    // re-creates sync and re-runs the effect below: a hot re-render loop while offline (also in aaf1555)
    if (!hasDue(s.queue, Date.now())) return; // rg8 B3: only ops on a parked op's id wait; others are due
    syncing.current = true;
    try {
      const sent = s.queue;
      const r = await flush(sent, sender);
      const { rest, profileRejected } = r;
      setS((p) => applyFlush({ ...p, ...(profileRejected ? { profileError: profileRejected } : {}) }, sent, r));
      // edge (a): a row flagged now (or before) that the server has but whose numbers the phone doesn't know: ask the server
      const flagged = new Set(r.failed.filter((f) => f.code === SERVER_ERROR).map((f) => f.id));
      await fillServerCopies(entriesRef.current.filter((e) => (flagged.has(e.id) || e.server_failed || e.delete_failed) && !e.server_counts && !r.rows?.[e.id]
        && typeof (r.versions[e.id] ?? e.server_version) === 'number').map((e) => e.id));
      // shown once (not persisted): the row is already gone from the phone
      if (r.gone?.length) setNotice(DELETED_ELSEWHERE);
      // a row held for its dish's units ('Check amount'): pull them again with the dish table
      if (entriesRef.current.some((e) => e.reject_code === UNITS_HELD && !e.deleted_at)) await pullUnits();
      if (!rest.some((o) => o.kind === 'forget' || o.kind === 'forgetAll')) {
        const rows = await api.getRemembered().catch(() => null);
        if (rows) setS((p) => ({ ...p, learned: fromRows(rows) }));
      }
    } finally { syncing.current = false; }
  }, [api, sender, s.queue, expireAi, pullUnits, fillServerCopies]);
  useEffect(() => { if (ready && s.queue.length && s.user) sync(); }, [ready, s.queue.length, s.user, sync]);
  // next build: while a restored row's amount is unknown ("—"), ask the server again every 30 s and when the app comes back
  const anyUnknown = s.entries.some((e) => e.amount_unknown && !e.deleted_at);
  useEffect(() => {
    if (!ready || !s.user || api.mock || !anyUnknown) return;
    const again = () => { void fillServerCopies(entriesRef.current.filter((e) => e.amount_unknown && !e.deleted_at).map((e) => e.id)); };
    const t = setInterval(again, 30_000);
    const sub = AppState.addEventListener?.('change', (a) => { if (a === 'active') again(); });
    return () => { clearInterval(t); sub?.remove?.(); };
  }, [ready, s.user, anyUnknown, api, fillServerCopies]);
  // retry with backoff: wake up when the head op's wait is over
  const headAt = nextDueAt(s.queue);
  useEffect(() => {
    if (!ready || !s.user || headAt === undefined) return;
    const t = setTimeout(() => { sync(); }, Math.max(0, headAt - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [ready, s.user, headAt, sync]);
  // PE: the dish units come down with the server's dish table and are kept on the phone (applied before any save)
  useEffect(() => { parser.setPulledUnits(s.dishUnits?.units ?? null, s.dishUnits?.version, s.dishUnits?.names); }, [s.dishUnits]);
  useEffect(() => {
    if (!ready || !s.user || api.mock) return;
    void pullUnits();
  }, [ready, s.user, api, pullUnits]);
  // refresh Remembered foods from the server when signed in
  useEffect(() => { if (ready && s.user && !api.mock) api.getRemembered().then((rows) => setS((p) => ({ ...p, learned: fromRows(rows) }))).catch(() => {}); }, [ready, s.user, api]);

  const upd = (f: (p: Persisted) => Persisted) => setS(f);
  const updateEntry = (e: FoodEntry): string | null => { const reason = entryRefusal(e); if (reason) return reason; upd((p) => {
      // before the edit: what the server has for a synced row nothing is queued for (rg8 F-1)
      const old = p.entries.find((x) => x.id === e.id);
      const was = old && !p.queue.some((o) => opId(o) === e.id) ? seedServerCounts(old) : old;
      const n = { ...e, ...(was?.server_counts && !e.server_counts ? { server_counts: was.server_counts } : {}), sync_error: undefined, sync_reason: undefined, sync_retrying: undefined, server_note: undefined, kept_on_server: undefined, amount_unknown: undefined, updated_at: new Date().toISOString() };
      return { ...p, entries: p.entries.map((x) => (x.id === e.id ? n : x)), queue: enqueue(p.queue, { kind: 'upsert', entry: n, tries: 0 }) };
    }); return null; };
  return {
    notice, dismissNotice,
    ready, ...s, api, sync, expireAi,
    newId: () => Crypto.randomUUID(),
    signIn: (u: User) => upd((p) => ({ ...p, user: u })),
    signOut: () => upd((p) => ({ ...p, user: null })),
    /** Saved on the phone at once; the server copy goes through the queue, so it is sent after sign-in too. */
    setProfile: (profile: Profile) => upd((p) => ({ ...p, profile, profileError: null, queue: enqueue(p.queue, { kind: 'profile', id: 'profile', payload: profilePayload(profile), tries: 0 }) })),
    setThemePref: (themePref: ThemePref) => upd((p) => ({ ...p, themePref })),
    /** Store guard (entryRefusal): typed kcal outside 1-5000, or a counted row with no real number, is refused. Returns the
     * refused ones with the reason; the caller keeps them open and shows it (never dropped silently). */
    addEntries: (all0: FoodEntry[]): Refused[] => {
      // a dish the phone has no units for: held for review ('Check amount', not counted) until they come down
      const all = all0.map((e) => (needsUnits(e) ? holdForUnits(e) : e));
      const refused = all.flatMap((e) => { const reason = entryRefusal(e); return reason ? [{ id: e.id, reason }] : []; });
      const es = all.filter((e) => !refused.some((r) => r.id === e.id));
      if (es.length) upd((p) => ({ ...p, entries: [...p.entries, ...es], queue: es.reduce((q, e) => enqueue(q, { kind: 'upsert', entry: e, tries: 0 }), p.queue) }));
      return refused;
    },
    /** Explicit user edit: the only way saved numbers change (same store guard). Returns the refusal reason, or null. */
    updateEntry,
    /** rg6 F4: a row the server refused for a type pick (variant_required): the picked type's numbers at the row's amount,
     * re-saved. Returns the refusal reason (row unchanged) if the pick can't be saved. */
    pickVariant: (id: string, dishId: string): string | null => {
      const e = entriesRef.current.find((x) => x.id === id); if (!e) return 'Not found.';
      // a type the phone's table doesn't have yet (a newer server table, rg7 B2): the server's own numbers for it, at this amount
      const o = e.variant_options?.find((x) => x.dish_id === dishId);
      if (!parser.dishById(dishId) && o) {
        const k = Math.round(o.kcal), p = Math.round(o.protein_g * 10) / 10;
        return updateEntry({ ...e, dish_id: dishId, kcal: { low: k, best: k, high: k }, protein_g: { low: p, best: p, high: p },
          variant_dish_id: dishId, variant_options: undefined, confirmed: true, needs_review: false, review_item: undefined, reject_code: undefined, server_note: undefined } as FoodEntry);
      }
      let it: Item;
      try { it = parser.recompute(dishId, e.qty, parser.unitSupported(dishId, e.unit) ? e.unit : parser.dishById(dishId)?.unit ?? e.unit, e.oil_level || ''); } catch { return 'Pick another type.'; }
      return updateEntry({ ...e, dish_id: dishId, qty: it.quantity, unit: it.unit, kcal: it.kcal, protein_g: it.protein_g, carbs_g: it.carbs_g, fat_g: it.fat_g,
        variant_dish_id: dishId, variant_options: undefined, confirmed: true, needs_review: false } as FoodEntry);
    },
    /** next build: read the server's copy of rows whose amount is unknown ("—") now (Progress tap) */
    refreshServerCopies: () => fillServerCopies(entriesRef.current.filter((e) => e.amount_unknown && !e.deleted_at).map((e) => e.id)),
    /** dismiss the "Saved as …" note on a row the server stored with other numbers */
    clearServerNote: (id: string) => upd((p) => ({ ...p, entries: p.entries.map((x) => (x.id === id && x.server_note && !x.needs_review ? { ...x, server_note: undefined } : x)) })),
    deleteEntry: (id: string) => upd((p) => {
      // next build: an edit the server never got (queued, or flagged 5xx) is replaced by this delete: marked, so a refused
      // delete restores the server's copy and names the edit (restoreKept), never drops it silently
      const x0 = p.entries.find((x) => x.id === id);
      const edited = !!x0 && typeof x0.server_version === 'number' && !x0.deleted_at
        && (!!x0.unsynced_edit || !!x0.server_failed || p.queue.some((o) => o.kind === 'upsert' && o.entry.id === id));
      return {
        // what the server has for it is recorded first (rg8 F-1): if the delete is flagged, the row counts exactly that (rg9 B3)
        ...p, entries: p.entries.map((x) => (x.id === id ? { ...(p.queue.some((o) => opId(o) === id) ? x : seedServerCounts(x)), deleted_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...(edited ? { unsynced_edit: true } : {}) } : x)),
        queue: enqueue(p.queue, { kind: 'delete', id, tries: 0, ...(edited ? { edited: true } : {}) }),
      };
    }),
    setSteps: (date: string, n: number) => upd((p) => ({ ...p, steps: { ...p.steps, [date]: n } })),
    setChallenge: (challenge: Challenge | null) => upd((p) => ({ ...p, challenge })),
    useAi: () => upd((p) => ({ ...p, aiQuota: countAi(p.aiQuota) })),
    /** The 35-minute backstop gave up on a server job: queued, so it is sent now when online and later when offline. */
    abandonJob: (jobId: string) => upd((p) => (jobId ? { ...p, queue: enqueue(p.queue, { kind: 'abandon', id: jobId, tries: 0 }) } : p)),
    /** Offline cache only; the server learns from the entry's span when it syncs. */
    remember: (pairs: [string, Reading][]) => upd((p) => ({ ...p, learned: { ...p.learned, ...Object.fromEntries(pairs) } })),
    /** Reset one (by key) or all. Server deletes go through the queue so they survive being offline. */
    forget: (key?: string) => upd((p) => {
      if (!key) return { ...p, learned: {}, queue: enqueue(p.queue, { kind: 'forgetAll', id: 'all', tries: 0 }) };
      const l = { ...p.learned }; const id = l[key]?.id; delete l[key];
      return { ...p, learned: l, queue: id === undefined ? p.queue : enqueue(p.queue, { kind: 'forget', id, tries: 0 }) };
    }),
    /** Foods added before their numbers were known: queued, never saved with a number. */
    /** Confirm a review entry with the (possibly corrected) item: it becomes a normal entry and syncs. */
    /** Returns why it was refused (the row stays in Review, showing this), or null. */
    confirmReview: (id: string, it: Item): string | null => {
      const old0 = entriesRef.current.find((e) => e.id === id);
      upd((p) => {
        const old = p.entries.find((e) => e.id === id); if (!old) return p;
        const r = confirmedFromReview(old, it); if (!r.entry) return p;
        return { ...p, entries: p.entries.map((e) => (e.id === id ? r.entry! : e)), queue: enqueue(p.queue, { kind: 'upsert', entry: r.entry, tries: 0 }) };
      });
      return old0 ? confirmedFromReview(old0, it).reason ?? null : null;
    },
    /** Placeholder / failed review row: the user's own typed kcal makes it a custom entry (never the placeholder number). */
    confirmReviewKcal: (id: string, kcal: number): string | null => { if (!validTypedKcal(kcal)) return TYPED_KCAL_REASON; upd((p) => {
      // store guard: 1-5000 only (empty, 0, negatives, NaN, > 5000 refused), like the server; the row stays with the reason
      const old = p.entries.find((e) => e.id === id); if (!old || !validTypedKcal(kcal)) return p;
      const k = Math.round(kcal), z = { low: 0, best: 0, high: 0 };
      // typed: plain custom, without the AI job's provenance (job_abandoned never refuses it). The name is the server's
      // custom_name (<= 120 bytes, cut at a word: G3); the whole meal text stays in raw_text
      const n: FoodEntry = { ...old, dish_id: null, custom_name: serverName(old.raw_text || old.review_item?.name || 'item') || 'item', source: 'custom', kcal: { low: k, best: k, high: k }, protein_g: z,
        carbs_g: 0, fat_g: 0, confirmed: true, needs_review: false, review_item: undefined, reject_code: undefined, variant_dish_id: undefined, job_id: undefined,
        sync_error: undefined, sync_reason: undefined, sync_retrying: undefined, updated_at: new Date().toISOString() } as FoodEntry;
      return { ...p, entries: p.entries.map((e) => (e.id === id ? n : e)), queue: enqueue(p.queue, { kind: 'upsert', entry: n, tries: 0 }) };
    }); return null; },
    /** "Couldn’t sync this. Tap to retry": the entry's current state goes through the queue again. */
    retrySync: (id: string) => upd((p) => {
      const e = p.entries.find((x) => x.id === id); if (!e?.sync_error) return p;
      const n = { ...e, sync_error: undefined, sync_reason: undefined, sync_retrying: true };
      return { ...p, entries: p.entries.map((x) => (x.id === id ? n : x)),
        queue: enqueue(p.queue, n.deleted_at ? { kind: 'delete', id, tries: 0, ...(n.unsynced_edit ? { edited: true } : {}) } : { kind: 'upsert', entry: n, tries: 0 }) };
    }),
    /** Remove a review entry (it is on the server as needs_review, so delete it there too). */
    dropReview: (id: string) => upd((p) => ({
      ...p, entries: p.entries.map((x) => (x.id === id ? { ...x, deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() } : x)),
      queue: enqueue(p.queue, { kind: 'delete', id, tries: 0 }),
    })),
    /** Late AI answer for a queued food (see fillPending): unconfirmed review entries, keyed by the stable id. */
    fillPending: (id: string, items: Item[]) => upd((p) => { const r = fillPending(p.entries, p.queue, id, items); return r.changed ? { ...p, entries: r.entries, queue: r.queue } : p; }),
    /** Queue foods with no number yet. `at` defaults to now; pass 0 to send them straight to items to review. */
    addPending: (fs: PendingFood[]) => upd((p) => {
      fs = fs.map((f) => ({ at: Date.now(), queued_at: Date.now(), ...f }));
      const ph = fs.map((f) => pendingEntry(f));
      let q = p.queue;
      for (let i = 0; i < fs.length; i++) { q = enqueue(q, { kind: 'upsert', entry: ph[i], tries: 0 }); q = enqueue(q, { kind: 'pending', food: fs[i], tries: 0 }); }
      return { ...p, entries: [...p.entries, ...ph], queue: q };
    }),
    /** Delete account: server erase, then the whole on-device store (profile incl. sex, entries, queue) is overwritten now. */
    deleteAll: async () => { await api.deleteMe().catch(() => {}); await kv.set(KEY, JSON.stringify(EMPTY)).catch(() => {}); setS(EMPTY); },
  };
}
export type Store = ReturnType<typeof useStoreValue>;
const Ctx = createContext<Store | null>(null);
export function StoreProvider({ children }: { children: ReactNode }) {
  const v = useStoreValue();
  return <Ctx.Provider value={v}>{children}</Ctx.Provider>;
}
export function useStore(): Store {
  const v = useContext(Ctx);
  if (!v) throw new Error('StoreProvider missing');
  return v;
}
