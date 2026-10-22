// Item 16: the evaluated app.config. Sign-in on: the live API by default, the public client ids, the reversed iOS id as the
// plugin's URL scheme; on by default for the iOS device build (HealthKit), off for Expo Go / plain runs; no push
// entitlement; expo-secure-store's biometric permissions blocked (the session is stored without biometrics).
const load = (env: Record<string, string | undefined>) => {
  const keep = { ...process.env };
  for (const k of ['EXPO_PUBLIC_FLAG_GOOGLE_SIGNIN', 'EXPO_PUBLIC_FLAG_HEALTHKIT', 'EXPO_PUBLIC_API_URL', 'EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID']) delete process.env[k];
  Object.assign(process.env, env);
  let cfg: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  jest.isolateModules(() => { cfg = require('../app.config').default; });
  process.env = keep;
  return cfg;
};
const IOS = '476615110591-j8oafjdlhq3srd77e8gf1smr9l4t5ua4.apps.googleusercontent.com';

test('APK with the flag: live API, the three public client ids', () => {
  const c = load({ EXPO_PUBLIC_FLAG_GOOGLE_SIGNIN: '1' });
  expect(c.extra.flags.googleSignIn).toBe(true);
  expect(c.extra.apiUrl).toBe('https://stoke-api.onrender.com');
  expect(c.extra.googleWebClientId).toBe('476615110591-3kvnih5da7902o3jlpu1ee5s5cbd1ct6.apps.googleusercontent.com');
  expect(c.extra.googleAndroidClientId).toBe('476615110591-55gphaeimlmm0kjgestjhdu30b93n61f.apps.googleusercontent.com');
  expect(c.extra.googleIosClientId).toBe(IOS);
  expect(c.plugins).toContainEqual(['@react-native-google-signin/google-signin', { iosUrlScheme: 'com.googleusercontent.apps.476615110591-j8oafjdlhq3srd77e8gf1smr9l4t5ua4' }]);
  expect(c.android.blockedPermissions).toEqual(expect.arrayContaining(['android.permission.USE_BIOMETRIC', 'android.permission.USE_FINGERPRINT']));
});

test('iOS device build (HealthKit): sign-in on by default, bundle id app.stokefit, no aps-environment; =0 turns it off', () => {
  const c = load({ EXPO_PUBLIC_FLAG_HEALTHKIT: '1' });
  expect(c.extra.flags.googleSignIn).toBe(true);
  expect(c.extra.apiUrl).toBe('https://stoke-api.onrender.com');
  expect(c.ios.bundleIdentifier).toBe('app.stokefit');
  expect(JSON.stringify(c)).not.toContain('aps-environment');
  expect(load({ EXPO_PUBLIC_FLAG_HEALTHKIT: '1', EXPO_PUBLIC_FLAG_GOOGLE_SIGNIN: '0' }).extra.flags.googleSignIn).toBe(false);
});

test('Expo Go / plain runs: off, no server', () => {
  const c = load({});
  expect(c.extra.flags.googleSignIn).toBe(false);
  expect(c.extra.apiUrl).toBe('');
});
