// Rest-done alert outside the app (Tester B1, spec §11): ONE local notification at the rest's stored end time, through
// expo-notifications (local only: no push server, no token). It is (re)scheduled whenever the rest's end changes (tick,
// −15s / +15s) and cancelled on skip, done-dismiss, finish and discard. A fixed identifier means a reschedule replaces
// the old one and a cancel works even after the app was killed and restarted.
// Permission: asked once, the first time a rest starts; denied → nothing is scheduled and we never ask again (the logger
// still vibrates while the app is open). Every call is guarded: a missing native module (Expo Go quirks, web, tests)
// must never break the logger.
import { Platform } from 'react-native';
import { kv } from './kv';

export const REST_ID = 'stoke-rest-end', REST_CHANNEL = 'rest-timer', ASKED_KEY = 'rest-notif-asked-v1';
export interface RestAlert {
  /** schedule (or replace) the alert for endsAt (ms); body like "Set 2 · 60 kg × 10" */
  schedule: (endsAt: number, body: string | null) => Promise<void>;
  cancel: () => Promise<void>;
}

type N = typeof import('expo-notifications');
let mod: N | null | undefined;
const load = (): N | null => {
  if (mod !== undefined) return mod;
  try { mod = Platform.OS === 'web' ? null : (require('expo-notifications') as N); } catch { mod = null; }
  return mod;
};

/** true while the rest timer is on screen with the app open: then the app vibrates itself, so the banner stays quiet */
let inApp = false;
export const setRestTimerVisible = (v: boolean) => { inApp = v; };
let setup: Promise<void> | null = null;
function ensureSetup(N: N): Promise<void> {
  if (!setup) {
    setup = (async () => {
      N.setNotificationHandler({
        handleNotification: async () => ({ shouldShowBanner: !inApp, shouldShowList: true, shouldPlaySound: !inApp, shouldSetBadge: false }),
      });
      if (Platform.OS === 'android') {
        await N.setNotificationChannelAsync(REST_CHANNEL, {
          name: 'Rest timer', importance: N.AndroidImportance.HIGH, vibrationPattern: [0, 300, 150, 300], sound: 'default',
          lockscreenVisibility: N.AndroidNotificationVisibility.PUBLIC,
        });
      }
    })().catch(() => { setup = null; });
  }
  return setup;
}
/** granted? Asks only the first time ever (kept on the phone), never again after a denial. */
async function allowed(N: N): Promise<boolean> {
  const p = await N.getPermissionsAsync();
  if (p.granted) return true;
  if (await kv.get(ASKED_KEY)) return false;
  await kv.set(ASKED_KEY, '1');
  if (!p.canAskAgain) return false;
  return (await N.requestPermissionsAsync()).granted;
}

/** one change at a time, in order: a quick tick then +15s must end with exactly the +15s alert */
let chain: Promise<void> = Promise.resolve();
const queue = (f: () => Promise<void>) => (chain = chain.then(f, f));
export const restAlert: RestAlert = {
  schedule: (endsAt, body) => queue(async () => {
    const N = load(); if (!N) return;
    try {
      await ensureSetup(N);
      await N.cancelScheduledNotificationAsync(REST_ID).catch(() => {});
      if (endsAt <= Date.now() + 1000 || !(await allowed(N))) return;
      await N.scheduleNotificationAsync({
        identifier: REST_ID,
        content: { title: 'Rest done', body: body ? `Next: ${body}` : 'Time for the next set', sound: 'default', vibrate: [0, 300, 150, 300] },
        trigger: { type: N.SchedulableTriggerInputTypes.DATE, date: new Date(endsAt), channelId: REST_CHANNEL },
      });
    } catch { /* no alert outside the app; the in-app vibration still works */ }
  }),
  cancel: () => queue(async () => {
    const N = load(); if (!N) return;
    try { await N.cancelScheduledNotificationAsync(REST_ID); } catch { /* nothing scheduled */ }
  }),
};
