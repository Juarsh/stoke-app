// Single source of truth for the app identity: Stoke (final name, CEO 21 Oct 2026). Everything is still
// overridable by env vars; these are the defaults. The Expo slug stays "placeholder-fit" on purpose: the EAS
// project behind the signed Expo Go link is tied to it, and it is never derived from the display name.
// Used by app.config.ts (native ids) and exposed to the UI via expo-constants.
module.exports = {
  name: process.env.APP_NAME || 'Stoke',
  slug: process.env.APP_SLUG || 'placeholder-fit',
  scheme: process.env.APP_SCHEME || 'stoke',
  androidPackage: process.env.APP_ANDROID_PACKAGE || 'app.stokefit',
  iosBundleId: process.env.APP_IOS_BUNDLE_ID || 'app.stokefit',
  inviteBaseUrl: process.env.APP_INVITE_BASE_URL || 'https://example.github.io/kc/j',
};
