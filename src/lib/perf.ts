import * as Device from 'expo-device';
import { Platform } from 'react-native';
/** Live blur is used ONLY on the floating nav bar, and disabled on low-end devices (<4 GB RAM or old year class). */
export const allowLiveBlur = (() => {
  if (Platform.OS === 'web') return false;
  const gb = (Device.totalMemory ?? 0) / 1024 ** 3;
  if (gb > 0 && gb < 3.8) return false;
  if (Device.deviceYearClass && Device.deviceYearClass < 2019) return false;
  return true;
})();
