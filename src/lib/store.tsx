import * as Crypto from 'expo-crypto';
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ThemePref } from '../theme';
import type { Learned, Reading } from './learned';
import { createApi } from './api';
import { FoodEntry, localDate, Profile } from './domain';
import { kv } from './kv';
import { enqueue, flush, Op } from './syncQueue';

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

  const sync = useCallback(async () => {
    if (api.mock) return; // mock mode: nothing leaves the device; queue is kept for later
    const rest = await flush(s.queue, api);
    setS((p) => ({ ...p, queue: rest }));
  }, [api, s.queue]);
  useEffect(() => { if (ready && s.queue.length && s.user) sync(); }, [ready, s.queue.length, s.user, sync]);

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
    remember: (pairs: [string, Reading][]) => {
      upd((p) => ({ ...p, learned: { ...p.learned, ...Object.fromEntries(pairs) } }));
      for (const [k, r] of pairs) api.putLearned(k, r).catch(() => {});
    },
    forget: (key?: string) => {
      upd((p) => { if (!key) return { ...p, learned: {} }; const l = { ...p.learned }; delete l[key]; return { ...p, learned: l }; });
      api.deleteLearned(key).catch(() => {});
    },
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
