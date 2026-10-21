// Apple HealthKit adapter (iOS) for the health interface in ./health, via @kingstinct/react-native-healthkit (Nitro).
// Read-only, steps only. The native module is loaded lazily (require inside each call) inside each call, so it never loads in
// Expo Go, on Android, or with EXPO_PUBLIC_FLAG_HEALTHKIT off (health.ts never picks this adapter then).
// Only connect() can show Apple's permission sheet.
// HealthKit never tells an app whether *read* access was granted (privacy): "connected" means we already asked, and a
// denied read simply returns 0 steps.
import type { HealthAdapter } from './health';

const STEPS = 'HKQuantityTypeIdentifierStepCount' as const;
const READ = { toRead: [STEPS] } as const;
const UNNECESSARY = 2; // AuthorizationRequestStatus.unnecessary: the user has already been asked for these types
// lazy require: evaluated on the first call only (never at app start, never in Expo Go / Android / flag off)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const load = (): typeof import('@kingstinct/react-native-healthkit') => require('@kingstinct/react-native-healthkit');

export const healthKit: HealthAdapter = {
  name: 'Apple Health',
  async status() {
    const hk = load();
    if (!hk.isHealthDataAvailable()) return 'unavailable';
    return (await hk.getRequestStatusForAuthorization(READ)) === UNNECESSARY ? 'connected' : 'not_connected';
  },
  async connect() {
    const hk = load();
    if (!hk.isHealthDataAvailable()) return false;
    return await hk.requestAuthorization(READ);
  },
  async steps(from, to) {
    const hk = load();
    // a statistics query: HealthKit de-duplicates iPhone + Watch steps and splits samples that cross the window edges
    const r = await hk.queryStatisticsForQuantity(STEPS, ['cumulativeSum'], { filter: { date: { startDate: from, endDate: to } }, unit: 'count' });
    return Math.round(r.sumQuantity?.quantity ?? 0);
  },
};
