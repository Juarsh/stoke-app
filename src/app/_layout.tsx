import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold } from '@expo-google-fonts/inter';
import { NotoSansDevanagari_400Regular, NotoSansDevanagari_500Medium, NotoSansDevanagari_600SemiBold, NotoSansDevanagari_700Bold } from '@expo-google-fonts/noto-sans-devanagari';
import { SpaceGrotesk_400Regular, SpaceGrotesk_500Medium, SpaceGrotesk_600SemiBold, SpaceGrotesk_700Bold } from '@expo-google-fonts/space-grotesk';
import { useFonts } from 'expo-font';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StoreProvider, useStore } from '@/lib/store';
import { ThemeProvider, useTheme } from '@/theme';

SplashScreen.preventAutoHideAsync().catch(() => {});

function Gate() {
  const st = useStore(); const t = useTheme();
  const seg = useSegments(); const router = useRouter();
  useEffect(() => {
    if (!st.ready) return;
    SplashScreen.hideAsync().catch(() => {});
    const top = seg[0] as string | undefined;
    if (!st.user && top !== 'sign-in') router.replace('/sign-in');
    else if (st.user && !st.profile && top !== 'onboarding') router.replace('/onboarding');
    else if (st.user && st.profile && (top === 'sign-in' || top === 'onboarding')) router.replace('/');
  }, [st.ready, st.user, st.profile, seg, router]);
  return (
    <>
      <StatusBar style={t.dark ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.c.bg } }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="settings" options={{ presentation: 'card' }} />
        <Stack.Screen name="share" options={{ presentation: 'modal' }} />
        <Stack.Screen name="remembered" />
      </Stack>
    </>
  );
}
function Themed() {
  const st = useStore();
  return <ThemeProvider pref={st.themePref}><Gate /></ThemeProvider>;
}
export default function Root() {
  const [loaded] = useFonts({
    Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold,
    SpaceGrotesk_400Regular, SpaceGrotesk_500Medium, SpaceGrotesk_600SemiBold, SpaceGrotesk_700Bold,
    // Devanagari fallback for both families (T/Field switch to these when text contains Hindi)
    NotoSansDevanagari_400Regular, NotoSansDevanagari_500Medium, NotoSansDevanagari_600SemiBold, NotoSansDevanagari_700Bold,
  });
  if (!loaded) return null;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StoreProvider><Themed /></StoreProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
