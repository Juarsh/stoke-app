// Item 16: "Sign in with Google" (sign-in screen and Settings). Google's sheet, then the server's session; the reason is
// shown when it fails (nothing changes on the phone then). Expo Go has no native sign-in: it says so and the app stays
// local-only.
import { useState } from 'react';
import { View } from 'react-native';
import { Button, T } from '@/components/ui';
import { NEEDS_APK, nativeGoogle, signInWithGoogle } from '@/lib/googleSignIn';
import { useStore } from '@/lib/store';

export function GoogleSignIn({ onDone }: { onDone?: () => void }) {
  const st = useStore();
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState<string | null>(null);
  if (!nativeGoogle()) return <T v="caption" tone="muted" accessibilityLiveRegion="polite">{NEEDS_APK}</T>;
  const go = async () => {
    setBusy(true); setWhy(null);
    try {
      const r = await signInWithGoogle(st.api);
      if (r.ok) { st.signInSession(r.user); onDone?.(); } else if (!r.cancelled) setWhy(r.reason);
    } finally { setBusy(false); }
  };
  return (
    <View style={{ gap: 8 }}>
      <Button title={busy ? 'Signing in…' : 'Sign in with Google'} disabled={busy} onPress={go} accessibilityLabel="Sign in with Google" />
      {why ? <T v="caption" tone="warn" accessibilityLiveRegion="polite">{why}</T> : null}
    </View>
  );
}
