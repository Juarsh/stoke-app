import type { ExpoConfig } from 'expo/config';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const brand = require('./brand.config.js');

const env = process.env;
// Apple Health (iOS): off unless EXPO_PUBLIC_FLAG_HEALTHKIT=1. The config plugin is only added then, so the default
// build has no HealthKit entitlement. Read-only (steps): no update/write description, no background delivery.
const healthKit = env.EXPO_PUBLIC_FLAG_HEALTHKIT === '1';
// Google sign-in (item 16): the public OAuth client ids (not secrets) of the Stoke Google Cloud project. Android: package
// app.stokefit + the debug keystore SHA-1; iOS: bundle id app.stokefit; Web: the audience of the ID token the server checks
// (GOOGLE_CLIENT_IDS on the server lists all three). Env overrides each.
const GOOGLE = {
  android: env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID || '476615110591-55gphaeimlmm0kjgestjhdu30b93n61f.apps.googleusercontent.com',
  web: env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID || '476615110591-3kvnih5da7902o3jlpu1ee5s5cbd1ct6.apps.googleusercontent.com',
  ios: env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID || '476615110591-j8oafjdlhq3srd77e8gf1smr9l4t5ua4.apps.googleusercontent.com',
};
// the iOS client id reversed: the URL scheme Google's sheet returns to (Info.plist)
const iosUrlScheme = 'com.googleusercontent.apps.' + GOOGLE.ios.replace(/\.apps\.googleusercontent\.com$/, '');
// On with EXPO_PUBLIC_FLAG_GOOGLE_SIGNIN=1 (the APK). The iOS device build on the Mac (EXPO_PUBLIC_FLAG_HEALTHKIT=1) has it
// on by default too (=0 turns it off). Expo Go / web runs leave it off unless asked (and Expo Go then says it needs the app).
const googleSignIn = env.EXPO_PUBLIC_FLAG_GOOGLE_SIGNIN === '1' || (env.EXPO_PUBLIC_FLAG_GOOGLE_SIGNIN !== '0' && healthKit);
// with sign-in on, the live server unless EXPO_PUBLIC_API_URL says otherwise; without it, no server (local / mock mode)
const apiUrl = env.EXPO_PUBLIC_API_URL || (googleSignIn ? 'https://stoke-api.onrender.com' : '');
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
    // expo-notifications also pulls in Firebase push (c2dm RECEIVE, WAKE_LOCK) and ShortcutBadger's launcher-badge
    // permissions. The rest alert is a local notification with no badge, so none of them ship (tools/build-apk.sh
    // allowlist); only POST_NOTIFICATIONS and RECEIVE_BOOT_COMPLETED are kept.
    blockedPermissions: [
      'android.permission.SYSTEM_ALERT_WINDOW',
      'com.google.android.c2dm.permission.RECEIVE', 'android.permission.WAKE_LOCK', 'android.permission.READ_APP_BADGE',
      'com.sec.android.provider.badge.permission.READ', 'com.sec.android.provider.badge.permission.WRITE',
      'com.htc.launcher.permission.READ_SETTINGS', 'com.htc.launcher.permission.UPDATE_SHORTCUT',
      'com.sonyericsson.home.permission.BROADCAST_BADGE', 'com.sonymobile.home.permission.PROVIDER_INSERT_BADGE',
      'com.anddoes.launcher.permission.UPDATE_COUNT', 'com.majeur.launcher.permission.UPDATE_BADGE',
      'com.huawei.android.launcher.permission.CHANGE_BADGE', 'com.huawei.android.launcher.permission.READ_SETTINGS',
      'com.huawei.android.launcher.permission.WRITE_SETTINGS', 'com.oppo.launcher.permission.READ_SETTINGS',
      'com.oppo.launcher.permission.WRITE_SETTINGS', 'me.everything.badger.permission.BADGE_COUNT_READ',
      'me.everything.badger.permission.BADGE_COUNT_WRITE',
    ],
  },
  web: { output: 'single', favicon: './assets/images/favicon.png' },
  plugins: [
    'expo-router',
    'expo-sqlite',
    'expo-sharing',
    ['expo-splash-screen', { backgroundColor: '#FFFFFF', image: './assets/images/splash-icon.png', imageWidth: 76 }],
    ['expo-build-properties', { android: { minSdkVersion: 26, compileSdkVersion: 36, targetSdkVersion: 35 } }],
    'expo-health-connect',
    // rest-done alert (Tester B1): expo-notifications' Android half only (icon + colour); local notifications, no push,
    // so no iOS aps-environment entitlement. The library adds POST_NOTIFICATIONS and RECEIVE_BOOT_COMPLETED.
    './plugins/withRestAlert.js',
    // Google sign-in without Firebase: the plugin only adds the iOS URL scheme; Android needs no config file. No push
    // (aps-environment) entitlement is added by it or by anything else here.
    ['@react-native-google-signin/google-signin', { iosUrlScheme }],
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
    apiUrl,
    googleAndroidClientId: GOOGLE.android,
    googleWebClientId: GOOGLE.web,
    googleIosClientId: GOOGLE.ios,
    flags: {
      steps: env.EXPO_PUBLIC_FLAG_STEPS !== '0',
      healthConnect: env.EXPO_PUBLIC_FLAG_HEALTH_CONNECT === '1',
      healthKit,
      community: env.EXPO_PUBLIC_FLAG_COMMUNITY !== '0',
      googleSignIn,
    },
  },
};
export default config;
