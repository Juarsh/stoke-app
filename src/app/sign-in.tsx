import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
import { useEffect } from 'react';
import { View } from 'react-native';
import { Button, Card, Screen, T } from '@/components/ui';
import { brand, config, flags } from '@/lib/config';
import { useStore } from '@/lib/store';

WebBrowser.maybeCompleteAuthSession();

/** Real Google sign-in (expo-auth-session). Only mounted when the flag is on AND client ids are configured. */
function GoogleButton() {
  const st = useStore();
  const [req, res, prompt] = Google.useIdTokenAuthRequest({ androidClientId: config.google.android || undefined, webClientId: config.google.web || undefined, iosClientId: config.google.ios || undefined });
  useEffect(() => {
    if (res?.type !== 'success') return;
    const tok = res.params.id_token;
    let name = 'You', email = '', sub = 'google';
    try { const p = JSON.parse(atob(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); name = p.name ?? name; email = p.email ?? ''; sub = p.sub ?? sub; } catch { /* backend verifies the token anyway */ }
    st.signIn({ id: sub, name, email, idToken: tok, mock: false });
  }, [res]); // eslint-disable-line react-hooks/exhaustive-deps
  return <Button title="Continue with Google" disabled={!req} onPress={() => prompt()} />;
}

export default function SignIn() {
  const st = useStore();
  return (
    <Screen>
      <View style={{ height: 80 }} />
      <T v="display" style={{ textAlign: 'center' }}>{brand.name}</T>
      <T tone="text2" style={{ textAlign: 'center' }}>Type “2 roti dal sabzi thoda ghee” and see calories + protein in a second.</T>
      <T v="caption" tone="muted" style={{ textAlign: 'center' }}>Free. No paywall.</T>
      <View style={{ height: 24 }} />
      {flags.googleSignIn ? <GoogleButton /> : (
        <Card tone="surface2">
          <T v="caption" tone="muted">Google sign-in isn’t configured in this build (mock mode).</T>
          <Button title="Continue with Google (mock)" onPress={() => st.signIn({ id: 'mock-user', name: 'Test user', email: 'test@example.com', idToken: null, mock: true })} />
        </Card>
      )}
      <T v="caption" tone="muted" style={{ textAlign: 'center' }}>By continuing you agree to the Terms & Privacy Policy.</T>
    </Screen>
  );
}
