import * as Device from 'expo-device';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';
/** Live blur is used ONLY on the floating nav, and turned off on low-RAM (<4 GB) / old devices. */
export const deviceAllowsBlur = (() => {
  if (Platform.OS === 'web') return false;
  const gb = (Device.totalMemory ?? 0) / 1024 ** 3;
  if (gb > 0 && gb < 3.8) return false;
  if (Device.deviceYearClass && Device.deviceYearClass < 2019) return false;
  return true;
})();
/** Also respects the OS "reduce transparency" setting (iOS) -> nav-solid token. */
export function useNavBlur(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    AccessibilityInfo.isReduceTransparencyEnabled?.().then(setReduce).catch(() => {});
    const sub = AccessibilityInfo.addEventListener?.('reduceTransparencyChanged', setReduce);
    return () => sub?.remove();
  }, []);
  return deviceAllowsBlur && !reduce;
}
