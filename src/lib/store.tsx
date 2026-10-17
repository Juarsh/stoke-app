import * as Crypto from 'expo-crypto';
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { abandonedEntry, dropLate, dropLateOps, expirePending, stampPending } from './aiBackstop';
import { AiQuota, countAi, EMPTY_QUOTA, noteReset } from './aiQuota';
import type { ThemePref } from '../theme';
import { fromRows, Learned, Reading } from './learned';
import { createApi } from './api';
import { entryFromItem, hasKcal, FoodEntry, mergeEntries, pendingEntry, Profile, profilePayload, reopenRejected, savableEntry, validTypedKcal } from './domain';
import { DISH_TABLE_VERSION, Item } from '../parser';
import { kv } from './kv';
import { fillPending, resolvePending } from './pending';
import { canConfirm } from './confirmBatch';
import { enqueue, flush, FlushResult, Op, PendingFood } from './syncQueue';

export interface User { id: string; name: string; email: string; idToken: string | null; mock: boolean }
export interface Challenge { code: string; title: string; startDate: string; members: { name: string; days: number }[] }
interface Persisted {
  /** server refused the profile (error.code): onboarding reopens with the values kept */
  profileError?: string | null;
  user: User | null; profile: Profile | null; entries: FoodEntry[]; steps: Record<string, number>;
  queue: Op[]; themePref: ThemePref; challenge: Challenge | null;
  /** the app's own per-user AI count; resets at the server's next_reset_at */
  aiQuota: AiQuota; learned: Learned;
}
const EMPTY: Persisted = { profileError: null, user: null, profile: null, entries: [], steps: {}, queue: [], themePref: 'system', challenge: null, aiQuota: EMPTY_QUOTA, learned: {} };
const KEY = 'app-state-v1';
/** 35-minute AI backstop on the whole state (same object back when nothing is due, so no re-render loop). */
/** The phone's entry is still the one that op sent (the user has not changed it since). */
const opId = (o: Op) => (o.kind === 'upsert' ? o.entry.id : (o as { id: string }).id);
const unchangedSince = (cur: FoodEntry | undefined, sent: FoodEntry) => !!cur && cur.updated_at === sent.updated_at && !cur.deleted_at;
/** After a flush: server versions recorded (a synced entry loses its sync error); refused / failed ops are handled ONLY when
 * the user has not changed the entry since it was sent, so a refusal never swallows a later typed value. Pure (testable). */
export function applyFlush<P extends { entries: FoodEntry[]; queue: Op[] }>(p: P, sent: Op[], r: Pick<FlushResult, 'rest' | 'resolved' | 'rejected' | 'versions' | 'failed'>): P {
  const now = new Date();
  const live = (e: FoodEntry) => p.entries.find((x) => x.id === e.id);
  const reopened = r.rejected.filter((x) => unchangedSince(live(x.entry), x.entry))
    // job_abandoned: the AI reading is refused for good; the row goes back to the failed row (typed kcal only)
    .map((x) => (x.code === 'job_abandoned' ? abandonedEntry(x.entry, now) : reopenRejected(x.entry, x.code, now, x.variant_options)));
  const failed = new Map(r.failed.filter((f) => { const cur = p.entries.find((x) => x.id === f.id); return !f.sent || unchangedSince(cur, f.sent); }).map((f) => [f.id, f.code]));
  // ops added (or coalesced, e.g. the backstop's row or the user's typed kcal) while we were sending stay queued after the
  // remaining ones and replace their same-id op; a late result for a job the backstop converted is ignored (dropLate / dropLateOps)
  const queue = dropLateOps(reopened.reduce((q, e) => enqueue(q, { kind: 'upsert', entry: e, tries: 0 }), p.queue.filter((o) => !sent.includes(o)).reduce((q, o) => enqueue(q, o), r.rest)), p.entries);
  const entries = mergeEntries(p.entries, dropLate(p.entries, r.resolved)).map((x) => {
    let n = reopened.find((e) => e.id === x.id) ?? x;
    const v = r.versions[x.id];
    if (typeof v === 'number') n = { ...n, server_version: v, ...(n.sync_error && !failed.has(x.id) ? { sync_error: undefined } : {}) };
    if (failed.has(x.id)) n = { ...n, sync_error: failed.get(x.id) };
    // retry spinner: done once that row's op has come back (failed again -> sync_error above, else synced)
    if (n.sync_retrying && (failed.has(x.id) || !queue.some((o) => opId(o) === x.id))) n = { ...n, sync_retrying: undefined };
    return n;
  });
  return { ...p, queue, entries };
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
  const api = useMemo(() => createApi(() => tokenRef.current, (iso) => setS((p) => { const q = noteReset(p.aiQuota, iso); return q === p.aiQuota ? p : { ...p, aiQuota: q }; })), []);

  useEffect(() => {
    kv.get(KEY).then((raw) => {
      if (!raw) return;
      const p: Persisted = { ...EMPTY, ...JSON.parse(raw) };
      setS(expireState({ ...p, queue: stampPending(p.queue, p.entries) })); // older queues get a start time; app start runs the backstop
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
    upsertEntry: (e: FoodEntry) => { const v = entriesRef.current.find((x) => x.id === e.id)?.server_version; return api.upsertEntry(v && v > (e.server_version ?? 0) ? { ...e, server_version: v } : e); }, deleteEntry: api.deleteEntry, deleteRemembered: api.deleteRemembered,
    resolvePending: (f: PendingFood) => resolvePending(api, f),
  }), [api]);
  const syncing = useRef(false);
  const entriesRef = useRef(s.entries);
  useEffect(() => { entriesRef.current = s.entries; }, [s.entries]);
  const sync = useCallback(async () => {
    if (api.mock || syncing.current) return; // mock mode: nothing leaves the device; queue is kept for later
    // job poll: anything past the 35-minute cutoff is converted first (the queue change re-runs sync without its poll)
    if (expirePending(entriesRef.current, s.queue).converted.length) { expireAi(); return; }
    // head still in its backoff (offline): the headAt timer wakes us. Flushing now would only rewrite the queue, which
    // re-creates sync and re-runs the effect below: a hot re-render loop while offline (also in aaf1555)
    if ((s.queue[0]?.nextAt ?? 0) > Date.now()) return;
    syncing.current = true;
    try {
      const sent = s.queue;
      const r = await flush(sent, sender);
      const { rest, profileRejected } = r;
      setS((p) => applyFlush({ ...p, ...(profileRejected ? { profileError: profileRejected } : {}) }, sent, r));
      if (!rest.some((o) => o.kind === 'forget' || o.kind === 'forgetAll')) {
        const rows = await api.getRemembered().catch(() => null);
        if (rows) setS((p) => ({ ...p, learned: fromRows(rows) }));
      }
    } finally { syncing.current = false; }
  }, [api, sender, s.queue, expireAi]);
  useEffect(() => { if (ready && s.queue.length && s.user) sync(); }, [ready, s.queue.length, s.user, sync]);
  // retry with backoff: wake up when the head op's wait is over
  const headAt = s.queue[0]?.nextAt;
  useEffect(() => {
    if (!ready || !s.user || headAt === undefined) return;
    const t = setTimeout(() => { sync(); }, Math.max(0, headAt - Date.now()) + 50);
    return () => clearTimeout(t);
  }, [ready, s.user, headAt, sync]);
  // refresh Remembered foods from the server when signed in
  useEffect(() => { if (ready && s.user && !api.mock) api.getRemembered().then((rows) => setS((p) => ({ ...p, learned: fromRows(rows) }))).catch(() => {}); }, [ready, s.user, api]);

  const upd = (f: (p: Persisted) => Persisted) => setS(f);
  return {
    ready, ...s, api, sync, expireAi,
    newId: () => Crypto.randomUUID(),
    signIn: (u: User) => upd((p) => ({ ...p, user: u })),
    signOut: () => upd((p) => ({ ...p, user: null })),
    /** Saved on the phone at once; the server copy goes through the queue, so it is sent after sign-in too. */
    setProfile: (profile: Profile) => upd((p) => ({ ...p, profile, profileError: null, queue: enqueue(p.queue, { kind: 'profile', id: 'profile', payload: profilePayload(profile), tries: 0 }) })),
    setThemePref: (themePref: ThemePref) => upd((p) => ({ ...p, themePref })),
    /** Store guard (savableEntry): a counted entry outside what the server accepts (typed kcal 1-5000) is refused. */
    addEntries: (all: FoodEntry[]) => upd((p) => { const es = all.filter(savableEntry); return es.length ? { ...p, entries: [...p.entries, ...es], queue: es.reduce((q, e) => enqueue(q, { kind: 'upsert', entry: e, tries: 0 }), p.queue) } : p; }),
    /** Explicit user edit: the only way saved numbers change (same store guard). */
    updateEntry: (e: FoodEntry) => upd((p) => {
      if (!savableEntry(e)) return p;
      const n = { ...e, sync_error: undefined, sync_retrying: undefined, updated_at: new Date().toISOString() };
      return { ...p, entries: p.entries.map((x) => (x.id === e.id ? n : x)), queue: enqueue(p.queue, { kind: 'upsert', entry: n, tries: 0 }) };
    }),
    deleteEntry: (id: string) => upd((p) => ({
      ...p, entries: p.entries.map((x) => (x.id === id ? { ...x, deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() } : x)),
      queue: enqueue(p.queue, { kind: 'delete', id, tries: 0 }),
    })),
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
    confirmReview: (id: string, it: Item) => upd((p) => {
      const old = p.entries.find((e) => e.id === id); if (!old) return p;
      if (!hasKcal(it) || !canConfirm(it)) return p; // never confirm 0 kcal, an unpicked variant/portion/unit, or a placeholder
      const n = { ...entryFromItem({ ...it, needs_confirmation: false }, { id, slot: old.slot, raw_text: old.raw_text, local_date: old.local_date, tableVersion: DISH_TABLE_VERSION, remember: !!it.dish_id }),
        ...(old.server_version ? { server_version: old.server_version } : {}),
        // an AI reading keeps its job, so a late AI save for an abandoned job is refused (job_abandoned), never counted
        ...(old.job_id && it.ai_estimate ? { job_id: old.job_id } : {}) };
      if (!savableEntry(n)) return p;
      return { ...p, entries: p.entries.map((e) => (e.id === id ? n : e)), queue: enqueue(p.queue, { kind: 'upsert', entry: n, tries: 0 }) };
    }),
    /** Placeholder / failed review row: the user's own typed kcal makes it a custom entry (never the placeholder number). */
    confirmReviewKcal: (id: string, kcal: number) => upd((p) => {
      // store guard: 1-5000 only (empty, 0, negatives, NaN, > 5000 refused), like the server
      const old = p.entries.find((e) => e.id === id); if (!old || !validTypedKcal(kcal)) return p;
      const k = Math.round(kcal), z = { low: 0, best: 0, high: 0 };
      // typed: plain custom, without the AI job's provenance (job_abandoned never refuses it)
      const n: FoodEntry = { ...old, dish_id: null, custom_name: old.raw_text || old.review_item?.name || 'item', source: 'custom', kcal: { low: k, best: k, high: k }, protein_g: z,
        carbs_g: 0, fat_g: 0, confirmed: true, needs_review: false, review_item: undefined, reject_code: undefined, variant_dish_id: undefined, job_id: undefined,
        sync_error: undefined, sync_retrying: undefined, updated_at: new Date().toISOString() } as FoodEntry;
      return { ...p, entries: p.entries.map((e) => (e.id === id ? n : e)), queue: enqueue(p.queue, { kind: 'upsert', entry: n, tries: 0 }) };
    }),
    /** "Couldn’t sync this. Tap to retry": the entry's current state goes through the queue again. */
    retrySync: (id: string) => upd((p) => {
      const e = p.entries.find((x) => x.id === id); if (!e?.sync_error) return p;
      const n = { ...e, sync_error: undefined, sync_retrying: true };
      return { ...p, entries: p.entries.map((x) => (x.id === id ? n : x)),
        queue: enqueue(p.queue, n.deleted_at ? { kind: 'delete', id, tries: 0 } : { kind: 'upsert', entry: n, tries: 0 }) };
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
