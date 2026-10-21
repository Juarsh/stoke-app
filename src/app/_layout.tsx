import { DMSans_400Regular, DMSans_500Medium, DMSans_600SemiBold, DMSans_700Bold } from '@expo-google-fonts/dm-sans';
import { NotoSansDevanagari_400Regular, NotoSansDevanagari_500Medium, NotoSansDevanagari_600SemiBold, NotoSansDevanagari_700Bold } from '@expo-google-fonts/noto-sans-devanagari';
import { useFonts } from 'expo-font';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NoticeToast } from '@/components/NoticeToast';
import { HabitToastHost } from '@/features/habits/HabitToastHost';
import { DocSync } from '@/lib/DocSync';
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
    // onboarding first (no account needed to start); sign-in comes after, as before
    if ((!st.profile || st.profileError) && top !== 'onboarding') router.replace('/onboarding');
    else if (st.profile && !st.user && top !== 'sign-in') router.replace('/sign-in');
    else if (st.user && st.profile && !st.profileError && (top === 'sign-in' || top === 'onboarding')) router.replace('/');
  }, [st.ready, st.user, st.profile, st.profileError, seg, router]);
  return (
    <>
      <StatusBar style={t.dark ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.c.bg } }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="settings" options={{ presentation: 'card' }} />
        <Stack.Screen name="share" options={{ presentation: 'modal' }} />
        <Stack.Screen name="remembered" />
        <Stack.Screen name="review" />
        <Stack.Screen name="credits" />
      </Stack>
      <NoticeToast />
      <HabitToastHost />
      <DocSync />
    </>
  );
}
function Themed() {
  const st = useStore();
  return <ThemeProvider pref={st.themePref}><Gate /></ThemeProvider>;
}
export default function Root() {
  const [loaded] = useFonts({
    // full-b2 type: DM Sans for everything
    DMSans_400Regular, DMSans_500Medium, DMSans_600SemiBold, DMSans_700Bold,
    // Devanagari fallback (T/Field switch to these when text contains Hindi)
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
