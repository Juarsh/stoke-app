// Item 16: Google sign-in with @react-native-google-signin (native; no Firebase). The flow with a mocked native library
// and server: Google's ID token (aud = the WEB client id) is traded for our session (POST /v1/auth/google), the session
// goes to the keystore, the user is our server's id. Every failure has a reason and saves nothing. Expo Go (no native
// module) says sign-in needs the APK and keeps local-only mode.
import React from 'react';
import { Platform } from 'react-native';
import { act, create } from 'react-test-renderer';

const mockCfg = { flag: true };
jest.mock('../src/lib/config', () => ({
  config: { apiUrl: 'http://api.test', mock: false, mockAi: false, mockAiDelay: 0, google: { android: 'and.apps.googleusercontent.com', web: 'web.apps.googleusercontent.com', ios: 'ios.apps.googleusercontent.com' } },
  get flags() { return { steps: true, community: true, healthConnect: false, googleSignIn: mockCfg.flag }; },
  brand: { name: 'Stoke', slug: 'placeholder-fit', scheme: 'stoke', androidPackage: 'app.stokefit', iosBundleId: 'app.stokefit', inviteBaseUrl: '' },
}));
const mockKeys: Record<string, string> = {};
jest.mock('expo-secure-store', () => ({
  getItemAsync: async (k: string) => mockKeys[k] ?? null, setItemAsync: async (k: string, v: string) => { mockKeys[k] = v; }, deleteItemAsync: async (k: string) => { delete mockKeys[k]; },
}));
const mockSignIn = jest.fn();
jest.mock('../src/lib/store', () => ({ ...jest.requireActual('../src/lib/store'), useStore: () => mockStore }));
jest.mock('@/components/ui', () => {
  const { Text, View } = jest.requireActual('react-native');
  return { Screen: ({ children }: { children: React.ReactNode }) => <View>{children}</View>, Card: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
    T: ({ children }: { children: React.ReactNode }) => <Text>{children}</Text>, Button: ({ title, onPress }: { title: string; onPress: () => void }) => <Text onPress={onPress}>{title}</Text> };
});

import { ApiError } from '../src/lib/api';
import { __setNativeGoogle, NEEDS_APK, nativeGoogle, signInWithGoogle } from '../src/lib/googleSignIn';
import { LOCAL_USER } from '../src/lib/store';
import SignIn from '../src/app/sign-in';

const statusCodes = { SIGN_IN_CANCELLED: '12501', IN_PROGRESS: 'IN_PROGRESS', PLAY_SERVICES_NOT_AVAILABLE: 'PSNA', SIGN_IN_REQUIRED: '4', NULL_PRESENTER: 'NULL_PRESENTER' };
function fakeLib(signIn: () => Promise<unknown>) {
  const g = { configure: jest.fn(), hasPlayServices: jest.fn(async () => true), signIn: jest.fn(signIn), signOut: jest.fn(async () => null) };
  return { lib: { GoogleSignin: g, statusCodes } as never, g };
}
const ok = (idToken: string | null = 'google.id.token') => async () => ({ type: 'success', data: { idToken, user: { email: 'akarsh@gmail.com', name: 'Akarsh', id: 'g-sub' } } });
const answer = { user: { id: 42, email: 'akarsh@gmail.com', name: 'Akarsh' }, session_token: 'stk_session', expires_at: '2027-01-21T00:00:00Z' };
let mockStore: Record<string, unknown> = {};
const setOS = (os: string) => Object.defineProperty(Platform, 'OS', { value: os, configurable: true });

beforeEach(() => { for (const k of Object.keys(mockKeys)) delete mockKeys[k]; mockSignIn.mockReset(); });
afterAll(() => setOS('ios'));

test('Expo Go / no native module: sign-in needs the APK, nothing is asked of Google or the server', async () => {
  __setNativeGoogle(undefined); // the real check: jest has no RNGoogleSignin native module
  expect(nativeGoogle()).toBeNull();
  const api = { signInGoogle: jest.fn() };
  expect(await signInWithGoogle(api)).toEqual({ ok: false, reason: NEEDS_APK });
  expect(api.signInGoogle).not.toHaveBeenCalled();
});

test('Android: webClientId configures Google, its ID token is traded for our session, kept in the keystore', async () => {
  setOS('android');
  const { lib, g } = fakeLib(ok());
  __setNativeGoogle(lib);
  const api = { signInGoogle: jest.fn(async () => answer) };
  const r = await signInWithGoogle(api);
  expect(g.configure).toHaveBeenCalledWith({ webClientId: 'web.apps.googleusercontent.com', offlineAccess: false });
  expect(g.hasPlayServices).toHaveBeenCalled();
  expect(api.signInGoogle).toHaveBeenCalledWith('google.id.token');
  expect(r).toEqual({ ok: true, user: { id: '42', name: 'Akarsh', email: 'akarsh@gmail.com', token: 'stk_session' } });
  expect(Object.values(mockKeys)).toEqual(['stk_session']);
});

test('iOS: iosClientId and webClientId both go to configure()', async () => {
  setOS('ios');
  let done!: Promise<void>;
  jest.isolateModules(() => {
    // a fresh module: configure() runs once per app run
    const m = require('../src/lib/googleSignIn') as typeof import('../src/lib/googleSignIn');
    const { lib, g } = fakeLib(ok());
    m.__setNativeGoogle(lib);
    done = m.signInWithGoogle({ signInGoogle: jest.fn(async () => answer) }).then((r) => {
      expect(r.ok).toBe(true);
      expect(g.configure).toHaveBeenCalledWith({ webClientId: 'web.apps.googleusercontent.com', iosClientId: 'ios.apps.googleusercontent.com', offlineAccess: false });
      expect(g.hasPlayServices).not.toHaveBeenCalled();
    });
  });
  await done;
});

test('cancelled: no reason, no server call, nothing saved', async () => {
  const { lib } = fakeLib(async () => ({ type: 'cancelled', data: null }));
  __setNativeGoogle(lib);
  const api = { signInGoogle: jest.fn() };
  expect(await signInWithGoogle(api)).toEqual({ ok: false, cancelled: true, reason: '' });
  expect(api.signInGoogle).not.toHaveBeenCalled();
  expect(mockKeys).toEqual({});
});

test('the server refuses (401 with its reason): shown, nothing saved, Google account choice reset', async () => {
  const { lib, g } = fakeLib(ok());
  __setNativeGoogle(lib);
  const api = { signInGoogle: jest.fn(async () => { throw new ApiError(401, JSON.stringify({ error: { code: 'invalid_token', message: 'Google sign-in was refused: invalid token: audience is not one of this server\'s client ids.' } })); }) };
  const r = await signInWithGoogle(api);
  expect(r).toEqual({ ok: false, reason: 'The server refused sign-in: Google sign-in was refused: invalid token: audience is not one of this server\'s client ids.' });
  expect(mockKeys).toEqual({});
  expect(g.signOut).toHaveBeenCalled();
});

test('offline, DEVELOPER_ERROR, Play services, no ID token: each has its own reason', async () => {
  const cases: [() => Promise<unknown>, RegExp, (() => Promise<never>)?][] = [
    [ok(), /Couldn’t reach the server/, async () => { throw new TypeError('Network request failed'); }],
    [async () => { throw Object.assign(new Error('DEVELOPER_ERROR'), { code: '10' }); }, /signing key or client id/],
    [async () => { throw Object.assign(new Error('x'), { code: 'PSNA' }); }, /Google Play services/],
    [ok(null), /didn’t return an ID token/],
  ];
  for (const [si, want, server] of cases) {
    const { lib } = fakeLib(si);
    __setNativeGoogle(lib);
    const r = await signInWithGoogle({ signInGoogle: jest.fn(server ?? (async () => answer)) });
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.reason).toMatch(want);
    expect(mockKeys).toEqual({});
  }
});

const texts = (r: ReturnType<typeof create>) => r.root.findAll((n) => typeof n.type === 'string').flatMap((n) => [n.props.children].flat()).filter((c) => typeof c === 'string');
const tap = async (r: ReturnType<typeof create>, title: string) => { const n = r.root.findAll((x) => x.props.onPress && [x.props.children].flat().includes(title)); await act(async () => { await n[0].props.onPress(); }); };

test('sign-in screen, flag off: the mock sign-in, as before', async () => {
  mockCfg.flag = false;
  mockStore = { signIn: mockSignIn, notice: null, dismissNotice: jest.fn() };
  let r!: ReturnType<typeof create>;
  await act(async () => { r = create(<SignIn />); });
  expect(texts(r)).toContain('Continue with Google (mock)');
  expect(texts(r)).not.toContain('Sign in with Google');
});

test('sign-in screen in Expo Go: "needs the APK" and local-only mode', async () => {
  mockCfg.flag = true; __setNativeGoogle(null);
  mockStore = { signIn: mockSignIn, notice: null, dismissNotice: jest.fn() };
  let r!: ReturnType<typeof create>;
  await act(async () => { r = create(<SignIn />); });
  expect(texts(r)).toContain(NEEDS_APK);
  expect(texts(r)).not.toContain('Sign in with Google');
  await tap(r, 'Use on this phone only');
  expect(mockSignIn).toHaveBeenCalledWith(LOCAL_USER);
});

test('sign-in screen, native: Sign in with Google signs in with the server session; the 401 notice is shown', async () => {
  mockCfg.flag = true;
  const { lib } = fakeLib(ok());
  __setNativeGoogle(lib);
  const signInSession = jest.fn();
  const fetchSpy = jest.fn(async () => ({ ok: true, status: 200, json: async () => answer, text: async () => JSON.stringify(answer) }));
  (global as { fetch: unknown }).fetch = fetchSpy;
  const { createApi } = jest.requireActual('../src/lib/api') as typeof import('../src/lib/api');
  mockStore = { signIn: mockSignIn, signInSession, api: createApi(() => null), notice: 'You were signed out (session expired or signed out). Everything is still on this phone; sign in again to sync it.', dismissNotice: jest.fn() };
  let r!: ReturnType<typeof create>;
  await act(async () => { r = create(<SignIn />); });
  expect(texts(r).some((t) => t.startsWith('You were signed out'))).toBe(true);
  await tap(r, 'Sign in with Google');
  expect(fetchSpy).toHaveBeenCalledWith('http://api.test/v1/auth/google', expect.objectContaining({ method: 'POST', body: JSON.stringify({ id_token: 'google.id.token' }) }));
  expect((fetchSpy.mock.calls[0] as unknown[])[1]).not.toHaveProperty('headers.Authorization');
  expect(signInSession).toHaveBeenCalledWith({ id: '42', name: 'Akarsh', email: 'akarsh@gmail.com', token: 'stk_session' });
});
