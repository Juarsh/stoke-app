// Redraw widgets on the home screen from the stored data (the app calls this after a change; see WidgetSync).
// The native module only exists in the Android app build: in Expo Go, on iOS / web, and in tests this does nothing.
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { loadWidgetData, type WidgetData } from './actions';
import { WIDGET_NAMES } from './model';

type Lib = typeof import('react-native-android-widget');
type Render = typeof import('./render');
let lib: Lib | null | undefined;
function widgetLib(): Lib | null {
  if (lib !== undefined) return lib;
  lib = null;
  if (Platform.OS !== 'android' || Constants.executionEnvironment === 'storeClient') return lib;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  try { lib = require('react-native-android-widget') as Lib; } catch { lib = null; }
  return lib;
}
export const widgetsAvailable = () => !!widgetLib();

export async function refreshWidgets(names: readonly string[] = WIDGET_NAMES, data?: WidgetData): Promise<void> {
  const l = widgetLib(); if (!l) return;
  // the widget JSX imports the library, so it loads only here (never in Expo Go)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { widgetFor } = require('./render') as Render;
  const d = data ?? await loadWidgetData();
  await Promise.all(names.map((widgetName) => l.requestWidgetUpdate({ widgetName, renderWidget: (info) => widgetFor(widgetName, d, info) ?? <></> }).catch(() => {})));
}
