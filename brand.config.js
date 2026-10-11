// Single source of truth for the (provisional) app identity. Names are on hold,
// so everything is overridable by env vars; these are only defaults.
// Used by app.config.ts (native ids) and exposed to the UI via expo-constants.
module.exports = {
  name: process.env.APP_NAME || 'KatoriCount',
  slug: process.env.APP_SLUG || 'katoricount',
  scheme: process.env.APP_SCHEME || 'katoricount',
  androidPackage: process.env.APP_ANDROID_PACKAGE || 'in.katoricount.app',
  iosBundleId: process.env.APP_IOS_BUNDLE_ID || 'in.katoricount.app',
  inviteBaseUrl: process.env.APP_INVITE_BASE_URL || 'https://example.github.io/kc/j',
};
