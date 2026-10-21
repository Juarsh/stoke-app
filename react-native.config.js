// Apple HealthKit is iOS-only. react-native-nitro-modules (its runtime) ships Android native code too; keep it, the
// HealthKit package and its core out of the Android build so the APK is unchanged by them.
module.exports = {
  dependencies: {
    '@kingstinct/react-native-healthkit': { platforms: { android: null } },
    '@react-native-healthkit/core': { platforms: { android: null } },
    'react-native-nitro-modules': { platforms: { android: null } },
  },
};
