import Constants from 'expo-constants';

type Extra = {
  brand: { name: string; slug: string; scheme: string; androidPackage: string; iosBundleId: string; inviteBaseUrl: string };
  apiUrl: string; googleAndroidClientId: string; googleWebClientId: string; googleIosClientId: string;
  flags: { steps: boolean; healthConnect: boolean; healthKit: boolean; community: boolean; googleSignIn: boolean };
};
const extra = (Constants.expoConfig?.extra ?? {}) as Partial<Extra>;
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const brand: Extra['brand'] = extra.brand ?? require('../../brand.config.js');
export const config = {
  apiUrl: extra.apiUrl ?? '',
  /** No backend URL -> the API client runs in mock mode (all local). */
  get mock() { return !this.apiUrl; },
  /** QA only: fake AI estimates in mock mode. */
  mockAi: process.env.EXPO_PUBLIC_MOCK_AI === '1',
  /** QA only: delay mock AI answers (ms) so the Estimating state can be captured. */
  mockAiDelay: Number(process.env.EXPO_PUBLIC_MOCK_AI_DELAY ?? 0),
  google: { android: extra.googleAndroidClientId ?? '', web: extra.googleWebClientId ?? '', ios: extra.googleIosClientId ?? '' },
};
/** Cut-order flags (spec): steps ring and Community tab can be switched off without layout changes. */
export const flags = {
  steps: extra.flags?.steps ?? true,
  healthConnect: extra.flags?.healthConnect ?? false,
  /** Apple Health steps (iOS dev/release build only; EXPO_PUBLIC_FLAG_HEALTHKIT=1). Off by default. */
  healthKit: extra.flags?.healthKit ?? false,
  community: extra.flags?.community ?? true,
  googleSignIn: (extra.flags?.googleSignIn ?? false) && !!(extra.googleAndroidClientId || extra.googleWebClientId),
};
