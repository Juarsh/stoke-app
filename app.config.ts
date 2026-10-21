import type { ExpoConfig } from 'expo/config';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const brand = require('./brand.config.js');

const env = process.env;
// Apple Health (iOS): off unless EXPO_PUBLIC_FLAG_HEALTHKIT=1. The config plugin is only added then, so the default
// build has no HealthKit entitlement. Read-only (steps): no update/write description, no background delivery.
const healthKit = env.EXPO_PUBLIC_FLAG_HEALTHKIT === '1';
const config: ExpoConfig = {
  name: brand.name,
  slug: brand.slug,
  scheme: brand.scheme,
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/images/icon.png',
  userInterfaceStyle: 'automatic',
  ios: { bundleIdentifier: brand.iosBundleId, supportsTablet: false },
  android: {
    package: brand.androidPackage,
    // no Android Auto Backup / device-transfer copy of app data (profile store incl. sex stays on this phone only)
    allowBackup: false,
    adaptiveIcon: {
      backgroundColor: '#FFFFFF',
      foregroundImage: './assets/images/android-icon-foreground.png',
      backgroundImage: './assets/images/android-icon-background.png',
      monochromeImage: './assets/images/android-icon-monochrome.png',
    },
    permissions: ['android.permission.health.READ_STEPS'],
    // RN's dev overlay permission must not ship (Tester P1 O4): removed from the merged release manifest
    blockedPermissions: ['android.permission.SYSTEM_ALERT_WINDOW'],
  },
  web: { output: 'single', favicon: './assets/images/favicon.png' },
  plugins: [
    'expo-router',
    'expo-sqlite',
    'expo-sharing',
    ['expo-splash-screen', { backgroundColor: '#FFFFFF', image: './assets/images/splash-icon.png', imageWidth: 76 }],
    ['expo-build-properties', { android: { minSdkVersion: 26, compileSdkVersion: 36, targetSdkVersion: 35 } }],
    'expo-health-connect',
    ...(healthKit ? [['@kingstinct/react-native-healthkit', {
      NSHealthShareUsageDescription: 'Stoke reads your step count from Apple Health to show your daily steps. It never writes to Apple Health.',
      NSHealthUpdateUsageDescription: false,
      background: false,
    }] as [string, object]] : []),
  ],
  experiments: { typedRoutes: true },
  extra: {
    brand,
    // Dev-only: lets a signed-in Expo Go open the dev server (signed manifest). Empty in release builds.
    ...(env.EAS_PROJECT_ID ? { eas: { projectId: env.EAS_PROJECT_ID } } : {}),
    apiUrl: env.EXPO_PUBLIC_API_URL || '',
    googleAndroidClientId: env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID || '',
    googleWebClientId: env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || '',
    googleIosClientId: env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID || '',
    flags: {
      steps: env.EXPO_PUBLIC_FLAG_STEPS !== '0',
      healthConnect: env.EXPO_PUBLIC_FLAG_HEALTH_CONNECT === '1',
      healthKit,
      community: env.EXPO_PUBLIC_FLAG_COMMUNITY !== '0',
      googleSignIn: env.EXPO_PUBLIC_FLAG_GOOGLE_SIGNIN === '1',
    },
  },
};
export default config;
