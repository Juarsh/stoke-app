// Rest timer alert (Tester B1): expo-notifications' Android part only (notification icon + colour). Local notifications
// only, so the iOS half of the stock plugin (the push "aps-environment" entitlement) is deliberately not applied.
const { withNotificationsAndroid } = require('expo-notifications/plugin/build/withNotificationsAndroid');

module.exports = (config) => withNotificationsAndroid(config, { icon: './assets/images/android-icon-monochrome.png', color: '#E3A44A' });
