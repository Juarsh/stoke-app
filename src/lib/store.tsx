import * as Crypto from 'expo-crypto';
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ThemePref } from '../theme';
import { fromRows, Learned, Reading } from './learned';
import { createApi } from './api';
import { entryFromItem, FoodEntry, localDate, mergeEntries, pendingEntry, Profile, profilePayload, reopenRejected } from './domain';
import { DISH_TABLE_VERSION, Item } from '../parser';
import { kv } from './kv';
import { fillPending, resolvePending } from './pending';
import { enqueue, flush, Op, PendingFood } from './syncQueue';

export interface User { id: string; name: string; email: string; idToken: string | null; mock: boolean }
export interface Challenge { code: string; title: string; startDate: string; members: { name: string; days: number }[] }
interface Persisted {
  /** server refused the profile (error.code): onboarding reopens with the values kept */
  profileError?: string | null;
  user: User | null; profile: Profile | null; entries: FoodEntry[]; steps: Record<string, number>;
  queue: Op[]; themePref: ThemePref; challenge: Challenge | null; aiUsed: Record<string, number>; learned: Learned;
}
const EMPTY: Persisted = { profileError: null, user: null, profile: null, entries: [], steps: {}, queue: [], themePref: 'system', challenge: null, aiUsed: {}, learned: {} };
const KEY = 'app-state-v1';

function useStoreValue() {
  const [s, setS] = useState<Persisted>(EMPTY);
  const [ready, setReady] = useState(false);
  const tokenRef = useRef<string | null>(null);
  tokenRef.current = s.user?.idToken ?? null;
  const api = useMemo(() => createApi(() => tokenRef.current), []);

  useEffect(() => {
    kv.get(KEY).then((raw) => { if (raw) setS({ ...EMPTY, ...JSON.parse(raw) }); }).finally(() => setReady(true));
  }, []);
  useEffect(() => { if (ready) kv.set(KEY, JSON.stringify(s)).catch(() => {}); }, [s, ready]);

  const sender = useMemo(() => ({
    putProfile: api.putProfile, upsertEntry: api.upsertEntry, deleteEntry: api.deleteEntry, deleteRemembered: api.deleteRemembered,
    resolvePending: (f: PendingFood) => resolvePending(api, f),
  }), [api]);
  const syncing = useRef(false);
  const sync = useCallback(async () => {
    if (api.mock || syncing.current) return; // mock mode: nothing leaves the device; queue is kept for later
    syncing.current = true;
    try {
      const sent = s.queue;
      const { rest, resolved, rejected, profileRejected } = await flush(sent, sender);
      const reopened = rejected.map((r) => reopenRejected(r.entry, r.code, new Date(), r.variant_options));
      // ops added while we were sending stay queued after the remaining ones
      setS((p) => ({ ...p, ...(profileRejected ? { profileError: profileRejected } : {}), queue: reopened.reduce((q, e) => enqueue(q, { kind: 'upsert', entry: e, tries: 0 }), [...rest, ...p.queue.slice(sent.length)]),
        entries: mergeEntries(p.entries, resolved).map((x) => reopened.find((r) => r.id === x.id) ?? x) }));
      if (!rest.some((o) => o.kind === 'forget' || o.kind === 'forgetAll')) {
        const rows = await api.getRemembered().catch(() => null);
        if (rows) setS((p) => ({ ...p, learned: fromRows(rows) }));
      }
    } finally { syncing.current = false; }
  }, [api, sender, s.queue]);
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
    ready, ...s, api, sync,
    newId: () => Crypto.randomUUID(),
    signIn: (u: User) => upd((p) => ({ ...p, user: u })),
    signOut: () => upd((p) => ({ ...p, user: null })),
    /** Saved on the phone at once; the server copy goes through the queue, so it is sent after sign-in too. */
    setProfile: (profile: Profile) => upd((p) => ({ ...p, profile, profileError: null, queue: enqueue(p.queue, { kind: 'profile', id: 'profile', payload: profilePayload(profile), tries: 0 }) })),
    setThemePref: (themePref: ThemePref) => upd((p) => ({ ...p, themePref })),
    addEntries: (es: FoodEntry[]) => upd((p) => ({ ...p, entries: [...p.entries, ...es], queue: es.reduce((q, e) => enqueue(q, { kind: 'upsert', entry: e, tries: 0 }), p.queue) })),
    /** Explicit user edit: the only way saved numbers change. */
    updateEntry: (e: FoodEntry) => upd((p) => {
      const n = { ...e, updated_at: new Date().toISOString() };
      return { ...p, entries: p.entries.map((x) => (x.id === e.id ? n : x)), queue: enqueue(p.queue, { kind: 'upsert', entry: n, tries: 0 }) };
    }),
    deleteEntry: (id: string) => upd((p) => ({
      ...p, entries: p.entries.map((x) => (x.id === id ? { ...x, deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() } : x)),
      queue: enqueue(p.queue, { kind: 'delete', id, tries: 0 }),
    })),
    setSteps: (date: string, n: number) => upd((p) => ({ ...p, steps: { ...p.steps, [date]: n } })),
    setChallenge: (challenge: Challenge | null) => upd((p) => ({ ...p, challenge })),
    useAi: () => upd((p) => ({ ...p, aiUsed: { [localDate()]: (p.aiUsed[localDate()] ?? 0) + 1 } })),
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
      const n = entryFromItem({ ...it, needs_confirmation: false }, { id, slot: old.slot, raw_text: old.raw_text, local_date: old.local_date, tableVersion: DISH_TABLE_VERSION, remember: !!it.dish_id });
      return { ...p, entries: p.entries.map((e) => (e.id === id ? n : e)), queue: enqueue(p.queue, { kind: 'upsert', entry: n, tries: 0 }) };
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
      fs = fs.map((f) => ({ at: Date.now(), ...f }));
      const ph = fs.map((f) => pendingEntry(f));
      let q = p.queue;
      for (let i = 0; i < fs.length; i++) { q = enqueue(q, { kind: 'upsert', entry: ph[i], tries: 0 }); q = enqueue(q, { kind: 'pending', food: fs[i], tries: 0 }); }
      return { ...p, entries: [...p.entries, ...ph], queue: q };
    }),
    deleteAll: async () => { await api.deleteMe().catch(() => {}); setS(EMPTY); },
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
