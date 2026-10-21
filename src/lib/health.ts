// Health Connect steps, behind flags.healthConnect (needs a dev build; not in Expo Go). Read-only, steps only (spec §3).
// Nothing here asks for permission on its own: only connectSteps() does, and only after the user taps Connect.
// Every call fails soft (returns 'unavailable' / false / null), so Home never crashes or waits on Health Connect.
import { Linking, Platform } from 'react-native';
import { flags } from './config';
import { dayOf, dayStartAt } from './domain';

export type StepsStatus = 'connected' | 'not_connected' | 'unavailable';
const STEPS = [{ accessType: 'read' as const, recordType: 'Steps' as const }];
const SDK_AVAILABLE = 3;
const hasSteps = (ps: unknown[]) => ps.some((g) => !!g && typeof g === 'object' && 'recordType' in g && (g as { recordType: string }).recordType === 'Steps');
const enabled = () => flags.steps && flags.healthConnect && Platform.OS === 'android';

/** Health Connect installed? Permission already granted? Never prompts. */
export async function stepsStatus(): Promise<StepsStatus> {
  if (!enabled()) return 'unavailable';
  try {
    const hc = await import('react-native-health-connect');
    if ((await hc.getSdkStatus()) !== SDK_AVAILABLE || !(await hc.initialize())) return 'unavailable';
    return hasSteps(await hc.getGrantedPermissions()) ? 'connected' : 'not_connected';
  } catch { return 'unavailable'; }
}
/** The Connect button: Android's own steps permission prompt. true when granted. */
export async function connectSteps(): Promise<boolean> {
  if (!enabled()) return false;
  try {
    const hc = await import('react-native-health-connect');
    if (!(await hc.initialize())) return false;
    return hasSteps(await hc.requestPermission(STEPS));
  } catch { return false; }
}
/** "Get Health Connect": its Play Store page. */
export const getHealthConnect = () => Linking.openURL('market://details?id=com.google.android.apps.healthdata').catch(() =>
  Linking.openURL('https://play.google.com/store/apps/details?id=com.google.android.apps.healthdata').catch(() => {}));

/** Today's steps when already connected; null otherwise (never prompts). */
export async function readTodaySteps(): Promise<number | null> {
  if ((await stepsStatus()) !== 'connected') return null;
  try {
    const hc = await import('react-native-health-connect');
    const start = dayStartAt(dayOf()); // the log day (4 AM), the same day Home saves the count under
    const r = await hc.readRecords('Steps', { timeRangeFilter: { operator: 'between', startTime: start.toISOString(), endTime: new Date().toISOString() } });
    return r.records.reduce((s, x) => s + x.count, 0);
  } catch { return null; }
}
