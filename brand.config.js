// Single source of truth for the (provisional) app identity. Names are on hold,
// so everything is overridable by env vars; these are only defaults.
// Used by app.config.ts (native ids) and exposed to the UI via expo-constants.
module.exports = {
  name: process.env.APP_NAME || 'Placeholder Fit',
  slug: process.env.APP_SLUG || 'placeholder-fit',
  scheme: process.env.APP_SCHEME || 'placeholderfit',
  androidPackage: process.env.APP_ANDROID_PACKAGE || 'app.placeholder.fit',
  iosBundleId: process.env.APP_IOS_BUNDLE_ID || 'app.placeholder.fit',
  inviteBaseUrl: process.env.APP_INVITE_BASE_URL || 'https://example.github.io/kc/j',
};
