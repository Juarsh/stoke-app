import * as Crypto from 'expo-crypto';
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ThemePref } from '../theme';
import { fromRows, Learned, Reading } from './learned';
import { createApi } from './api';
import { entryFromItem, FoodEntry, localDate, Profile } from './domain';
import { DISH_TABLE_VERSION, Item } from '../parser';
import { kv } from './kv';
import { resolvePending } from './pending';
import { enqueue, flush, Op, PendingFood } from './syncQueue';

export interface User { id: string; name: string; email: string; idToken: string | null; mock: boolean }
export interface Challenge { code: string; title: string; startDate: string; members: { name: string; days: number }[] }
interface Persisted {
  user: User | null; profile: Profile | null; entries: FoodEntry[]; steps: Record<string, number>;
  queue: Op[]; themePref: ThemePref; challenge: Challenge | null; aiUsed: Record<string, number>; learned: Learned;
}
const EMPTY: Persisted = { user: null, profile: null, entries: [], steps: {}, queue: [], themePref: 'system', challenge: null, aiUsed: {}, learned: {} };
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
    upsertEntry: api.upsertEntry, deleteEntry: api.deleteEntry, deleteRemembered: api.deleteRemembered,
    resolvePending: (f: PendingFood) => resolvePending(api, f),
  }), [api]);
  const syncing = useRef(false);
  const sync = useCallback(async () => {
    if (api.mock || syncing.current) return; // mock mode: nothing leaves the device; queue is kept for later
    syncing.current = true;
    try {
      const sent = s.queue;
      const { rest, resolved } = await flush(sent, sender);
      // ops added while we were sending stay queued after the remaining ones
      setS((p) => ({ ...p, queue: [...rest, ...p.queue.slice(sent.length)], entries: [...p.entries, ...resolved] }));
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
    setProfile: (profile: Profile) => { upd((p) => ({ ...p, profile })); api.putProfile(profile).catch(() => {}); },
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
    /** Remove a review entry: it was never synced, so it just goes. */
    dropReview: (id: string) => upd((p) => ({ ...p, entries: p.entries.filter((e) => e.id !== id) })),
    addPending: (fs: PendingFood[]) => upd((p) => ({ ...p, queue: fs.reduce((q, food) => enqueue(q, { kind: 'pending', food, tries: 0 }), p.queue) })),
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
