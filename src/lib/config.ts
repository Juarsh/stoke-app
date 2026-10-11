import Constants from 'expo-constants';

type Extra = {
  brand: { name: string; slug: string; scheme: string; androidPackage: string; iosBundleId: string; inviteBaseUrl: string };
  apiUrl: string; googleAndroidClientId: string; googleWebClientId: string; googleIosClientId: string;
  flags: { steps: boolean; healthConnect: boolean; community: boolean; googleSignIn: boolean };
};
const extra = (Constants.expoConfig?.extra ?? {}) as Partial<Extra>;
export const brand = extra.brand ?? { name: 'App', slug: 'app', scheme: 'app', androidPackage: '', iosBundleId: '', inviteBaseUrl: '' };
export const config = {
  apiUrl: extra.apiUrl ?? '',
  /** No backend URL -> the API client runs in mock mode (all local). */
  get mock() { return !this.apiUrl; },
  /** QA only: fake AI estimates in mock mode. */
  mockAi: process.env.EXPO_PUBLIC_MOCK_AI === '1',
  google: { android: extra.googleAndroidClientId ?? '', web: extra.googleWebClientId ?? '', ios: extra.googleIosClientId ?? '' },
};
/** Cut-order flags (spec): steps ring and Community tab can be switched off without layout changes. */
export const flags = {
  steps: extra.flags?.steps ?? true,
  healthConnect: extra.flags?.healthConnect ?? false,
  community: extra.flags?.community ?? true,
  googleSignIn: (extra.flags?.googleSignIn ?? false) && !!(extra.googleAndroidClientId || extra.googleWebClientId),
};
