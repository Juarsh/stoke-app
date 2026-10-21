// Health Connect adapter (Android) for the health interface in ./health. Read-only, steps only.
// The native module is loaded lazily (require inside each call) inside each call, so nothing loads unless health.ts picked this
// adapter (Android + flags.healthConnect + not Expo Go). Only connect() can show the permission prompt.
import { Linking } from 'react-native';
import type { HealthAdapter } from './health';

const STEPS = [{ accessType: 'read' as const, recordType: 'Steps' as const }];
const SDK_AVAILABLE = 3;
const hasSteps = (ps: unknown[]) => ps.some((g) => !!g && typeof g === 'object' && 'recordType' in g && (g as { recordType: string }).recordType === 'Steps');
// lazy require: evaluated on the first call only (never at app start, never in Expo Go / iOS / flag off)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const load = (): typeof import('react-native-health-connect') => require('react-native-health-connect');

export const healthConnect: HealthAdapter = {
  name: 'Health Connect',
  async status() {
    const hc = load();
    if ((await hc.getSdkStatus()) !== SDK_AVAILABLE || !(await hc.initialize())) return 'unavailable';
    return hasSteps(await hc.getGrantedPermissions()) ? 'connected' : 'not_connected';
  },
  async connect() {
    const hc = load();
    if (!(await hc.initialize())) return false;
    return hasSteps(await hc.requestPermission(STEPS));
  },
  async steps(from, to) {
    const hc = load();
    const r = await hc.readRecords('Steps', { timeRangeFilter: { operator: 'between', startTime: from.toISOString(), endTime: to.toISOString() } });
    return r.records.reduce((s, x) => s + x.count, 0);
  },
  /** "Get Health Connect": its Play Store page. */
  async install() {
    await Linking.openURL('market://details?id=com.google.android.apps.healthdata').catch(() =>
      Linking.openURL('https://play.google.com/store/apps/details?id=com.google.android.apps.healthdata').catch(() => {}));
  },
};
