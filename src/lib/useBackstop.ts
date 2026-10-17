import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';

/** How often an open Log / Review screen re-checks the 35-minute AI backstop. */
export const BACKSTOP_TICK_MS = 30_000;
/** Runs `check` now, every BACKSTOP_TICK_MS and on foreground, while the screen is focused. */
export function useBackstopTick(check: () => void) {
  const ref = useRef(check);
  useEffect(() => { ref.current = check; });
  useFocusEffect(useCallback(() => {
    ref.current();
    const t = setInterval(() => ref.current(), BACKSTOP_TICK_MS);
    const sub = AppState.addEventListener?.('change', (a) => { if (a === 'active') ref.current(); });
    return () => { clearInterval(t); sub?.remove?.(); };
  }, []));
}
