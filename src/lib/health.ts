// Steps from the phone's health store, behind ONE interface with two adapters (needs a dev/release build; never Expo Go):
//   Android -> Health Connect (./healthConnect), on with flags.healthConnect (EXPO_PUBLIC_FLAG_HEALTH_CONNECT=1)
//   iOS     -> Apple Health   (./healthKit),     on with flags.healthKit     (EXPO_PUBLIC_FLAG_HEALTHKIT=1)
// Read-only, steps only (spec §3). Nothing here asks for permission on its own: only connectSteps() does, and only after
// the user taps Connect. Every call fails soft ('unavailable' / false / null), so Home never crashes or waits on it.
// The day window is the 4 AM log day from dayOf()/dayStartAt(), the same day Home saves the count under.
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { flags } from './config';
import { dayOf, dayStartAt } from './domain';
import { healthConnect } from './healthConnect';
import { healthKit } from './healthKit';

export type StepsStatus = 'connected' | 'not_connected' | 'unavailable';
export interface HealthAdapter {
  name: 'Apple Health' | 'Health Connect';
  /** Is the store there, and have we got (or already asked for) steps? Never prompts. */
  status(): Promise<StepsStatus>;
  /** The OS permission prompt. Only ever called from a Connect button. */
  connect(): Promise<boolean>;
  /** Total steps between from and to. Never prompts. */
  steps(from: Date, to: Date): Promise<number>;
  /** Where to get the store app when it is missing (Health Connect only; Apple Health is built in). */
  install?(): Promise<void>;
}

/** The store's name for this platform, for the Connect UI: "Apple Health" on iOS, "Health Connect" elsewhere. */
export const healthName = (): HealthAdapter['name'] => (Platform.OS === 'ios' ? 'Apple Health' : 'Health Connect');
/** Expo Go (ExecutionEnvironment.StoreClient): no HealthKit / Health Connect native code there. */
const isExpoGo = () => (Constants as { executionEnvironment?: string } | undefined)?.executionEnvironment === 'storeClient';
/** The adapter for this build, or null (flag off, Expo Go, web). Picking it loads no native code. */
export function healthAdapter(): HealthAdapter | null {
  if (!flags.steps || isExpoGo()) return null;
  if (Platform.OS === 'ios') return flags.healthKit ? healthKit : null;
  if (Platform.OS === 'android') return flags.healthConnect ? healthConnect : null;
  return null;
}
/** Is a health store switched on in this build (the Connect button is live)? */
export const healthEnabled = () => healthAdapter() !== null;

/** Store there? Steps already allowed? Never prompts. */
export async function stepsStatus(): Promise<StepsStatus> {
  const a = healthAdapter();
  if (!a) return 'unavailable';
  try { return await a.status(); } catch { return 'unavailable'; }
}
/** The Connect button: the OS's own steps permission prompt. true when granted (iOS: when the sheet was answered). */
export async function connectSteps(): Promise<boolean> {
  const a = healthAdapter();
  if (!a) return false;
  try { return await a.connect(); } catch { return false; }
}
/** "Get Health Connect" (Android); a no-op where the store is built in. */
export const getHealthApp = async () => { await healthAdapter()?.install?.().catch(() => {}); };
/** The 4 AM log day containing `now`: [start of that day, now]. */
export const stepsWindow = (now = new Date()) => ({ from: dayStartAt(dayOf(now)), to: now });

/** Today's steps when already connected; null otherwise (never prompts). */
export async function readTodaySteps(now = new Date()): Promise<number | null> {
  const a = healthAdapter();
  if (!a || (await stepsStatus()) !== 'connected') return null;
  try { const w = stepsWindow(now); return await a.steps(w.from, w.to); } catch { return null; }
}
