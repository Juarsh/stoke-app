import { View } from 'react-native';
import { Button, Card, Screen, T } from '@/components/ui';
import { GoogleSignIn } from '@/features/account/GoogleSignIn';
import { brand, flags } from '@/lib/config';
import { LOCAL_USER, useStore } from '@/lib/store';

/** Sign-in (item 16). With the googleSignIn flag: Google (native, the APK / iOS app) or "Use on this phone only"
 * (local-only: nothing is sent; Settings can sign in later and everything on the phone goes up then). Without the flag:
 * the mock sign-in, as before. */
export default function SignIn() {
  const st = useStore();
  return (
    <Screen>
      <View style={{ height: 80 }} />
      <T v="display" style={{ textAlign: 'center' }}>{brand.name}</T>
      <T tone="text2" style={{ textAlign: 'center' }}>Type “2 roti dal sabzi thoda ghee” and see calories + protein in a second.</T>
      <T v="caption" tone="muted" style={{ textAlign: 'center' }}>Free. No paywall.</T>
      {st.notice ? <T v="caption" tone="warn" accessibilityLiveRegion="polite" style={{ textAlign: 'center' }}>{st.notice}</T> : null}
      <View style={{ height: 24 }} />
      {flags.googleSignIn ? (
        <>
          <GoogleSignIn />
          <Button kind="ghost" title="Use on this phone only" onPress={() => { st.dismissNotice(); st.signIn(LOCAL_USER); }} />
          <T v="caption" tone="muted" style={{ textAlign: 'center' }}>Signing in backs up and syncs your logs, plans and habits. You can sign in later from Settings.</T>
        </>
      ) : (
        <Card tone="surface2">
          <T v="caption" tone="muted">Google sign-in isn’t configured in this build (mock mode).</T>
          <Button title="Continue with Google (mock)" onPress={() => st.signIn({ id: 'mock-user', name: 'Test user', email: 'test@example.com', idToken: null, mock: true })} />
        </Card>
      )}
      <T v="caption" tone="muted" style={{ textAlign: 'center' }}>By continuing you agree to the Terms & Privacy Policy.</T>
    </Screen>
  );
}
