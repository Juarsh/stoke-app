// App entry: expo-router's, plus the Android home-screen widget task handler (src/widgets). The handler needs the
// widget native module, which only the Android app build has (not Expo Go, iOS or web), so it is registered only there.
import 'expo-router/entry';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

if (Platform.OS === 'android' && Constants.executionEnvironment !== 'storeClient') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerWidgetTaskHandler } = require('react-native-android-widget');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    registerWidgetTaskHandler(require('./src/widgets/handler').widgetTaskHandler);
  } catch { /* no widget module in this build */ }
}
