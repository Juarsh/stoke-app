// Google sign-in (item 16): @react-native-google-signin/google-signin, no Firebase / google-services.json. The ID token
// comes from Google with aud = the WEB client id (webClientId), the server trades it for our own session
// (api.signInGoogle), and the session is kept in the keystore (./session). Behind flags.googleSignIn
// (EXPO_PUBLIC_FLAG_GOOGLE_SIGNIN=1).
// The native module is only required when used, and never in Expo Go (it has no such native code): there, sign-in says it
// needs the APK and the app stays local-only.
import Constants from 'expo-constants';
import { Platform, TurboModuleRegistry } from 'react-native';
import { ApiError, type Api } from './api';
import { config } from './config';
import { session } from './session';

type Lib = typeof import('@react-native-google-signin/google-signin');
let lib: Lib | null | undefined;

export const isExpoGo = () => (Constants as { executionEnvironment?: string } | undefined)?.executionEnvironment === 'storeClient';
export const NEEDS_APK = Platform.OS === 'ios' ? 'Sign-in needs the installed app (not Expo Go). Your data stays on this phone.' : 'Sign-in needs the APK (not Expo Go). Your data stays on this phone.';

/** The native library, or null when this runtime has none (Expo Go, web, a build without it). Never throws. */
export function nativeGoogle(): Lib | null {
  if (lib !== undefined) return lib;
  lib = null;
  if (isExpoGo() || Platform.OS === 'web') return lib;
  try {
    if (!TurboModuleRegistry.get('RNGoogleSignin')) return lib;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    lib = require('@react-native-google-signin/google-signin') as Lib;
  } catch { lib = null; }
  return lib;
}
/** tests only */
export function __setNativeGoogle(l: Lib | null | undefined) { lib = l; }

export type SignedIn = { id: string; name: string; email: string; token: string };
export type SignInOutcome = { ok: true; user: SignedIn } | { ok: false; cancelled?: boolean; reason: string };

let configured = false;
function configure(g: Lib) {
  if (configured) return;
  g.GoogleSignin.configure({ webClientId: config.google.web, ...(Platform.OS === 'ios' && config.google.ios ? { iosClientId: config.google.ios } : {}), offlineAccess: false });
  configured = true;
}

/** Google's sheet, then the server's session. A failure returns why (shown on screen); nothing is saved then. */
export async function signInWithGoogle(api: Pick<Api, 'signInGoogle'>): Promise<SignInOutcome> {
  const g = nativeGoogle();
  if (!g) return { ok: false, reason: NEEDS_APK };
  if (!config.apiUrl) return { ok: false, reason: 'This build has no server (EXPO_PUBLIC_API_URL), so there is nothing to sign in to.' };
  if (!config.google.web) return { ok: false, reason: 'This build has no Google client id (EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID).' };
  let idToken: string | null = null, name = '', email = '';
  try {
    configure(g);
    if (Platform.OS === 'android') await g.GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    const r = await g.GoogleSignin.signIn();
    if (r.type !== 'success') return { ok: false, cancelled: true, reason: '' };
    idToken = r.data.idToken; name = r.data.user.name ?? ''; email = r.data.user.email ?? '';
  } catch (e) {
    const code = String((e as { code?: unknown })?.code ?? '');
    if (code === g.statusCodes.SIGN_IN_CANCELLED) return { ok: false, cancelled: true, reason: '' };
    if (code === g.statusCodes.IN_PROGRESS) return { ok: false, reason: 'Sign-in is already open.' };
    if (code === g.statusCodes.PLAY_SERVICES_NOT_AVAILABLE) return { ok: false, reason: 'Google Play services is missing or out of date on this phone.' };
    // DEVELOPER_ERROR (10): the app's signing SHA-1 / package isn't on the Android OAuth client, or the web client id is wrong
    if (code === '10' || /DEVELOPER_ERROR/.test(String((e as Error)?.message))) return { ok: false, reason: 'Google refused this build (its signing key or client id isn’t registered).' };
    return { ok: false, reason: `Google sign-in failed: ${(e as Error)?.message ?? code}` };
  }
  if (!idToken) return { ok: false, reason: 'Google didn’t return an ID token (check the web client id).' };
  try {
    const a = await api.signInGoogle(idToken);
    await session.save(a.session_token);
    return { ok: true, user: { id: String(a.user.id), name: a.user.name || name || 'You', email: a.user.email || email, token: a.session_token } };
  } catch (e) {
    await g.GoogleSignin.signOut().catch(() => null); // let the next try pick an account again
    if (e instanceof ApiError) return { ok: false, reason: `The server refused sign-in: ${e.reason || `HTTP ${e.status}`}` };
    return { ok: false, reason: 'Couldn’t reach the server. Check your connection and try again.' };
  }
}

/** Forget Google's account choice on this phone (best effort). */
export async function signOutGoogle(): Promise<void> {
  const g = nativeGoogle();
  if (g) await g.GoogleSignin.signOut().catch(() => null);
}
