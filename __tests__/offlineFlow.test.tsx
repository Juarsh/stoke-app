// P1 item 7: the whole P1 flow with no API URL and every network call failing: onboarding, sign-in (mock), Home, Log food,
// My foods, the timeline (edit, remove, Undo), then an app restart. Nothing may hang or show a generic error, and the data
// must come back after the restart. The screens are the real ones on the real store; a tiny router stands in for expo-router.
import React, { useState } from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { TextInput } from 'react-native';

jest.mock('../src/lib/config', () => ({ config: { mock: true, apiUrl: '', mockAi: false, mockAiDelay: 0, google: { android: '', web: '', ios: '' } },
  flags: {}, brand: { name: 'Placeholder Fit' } }));
let mockSaved: string | null = null;
jest.mock('../src/lib/kv', () => ({ kv: { get: async () => mockSaved, set: async (_k: string, v: string) => { mockSaved = v; } } }));
let mockN = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `id${++mockN}` }));
jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual('react-native');
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});
jest.mock('expo-auth-session/providers/google', () => ({ useIdTokenAuthRequest: () => [null, null, jest.fn()] }));
jest.mock('expo-web-browser', () => ({ maybeCompleteAuthSession: jest.fn() }));
const mockNav = { go: (_p: string) => {}, back: () => {} };
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: (p: string | { pathname: string }) => mockNav.go(typeof p === 'string' ? p : p.pathname), replace: (p: string) => mockNav.go(p), back: () => mockNav.back() }),
  useLocalSearchParams: () => ({}), useSegments: () => [],
}));

import { StoreProvider, useStore } from '../src/lib/store';
import { counted } from '../src/lib/domain';
import Onboarding from '../src/app/onboarding';
import SignIn from '../src/app/sign-in';
import Home from '../src/app/(tabs)/index';
import { LogFoodScreen } from '../src/features/logfood/LogFoodScreen';
import { MyFoodsScreen } from '../src/features/myfoods/MyFoodsScreen';
import { NewFoodScreen } from '../src/features/myfoods/NewFoodScreen';
import { TimelineScreen } from '../src/features/timeline/TimelineScreen';
import { NoticeToast } from '../src/components/NoticeToast';

const ROUTES: Record<string, React.ComponentType> = { '/': Home, '/food': TimelineScreen, '/log-food': LogFoodScreen, '/my-foods': MyFoodsScreen, '/my-food-new': NewFoodScreen };
let st!: ReturnType<typeof useStore>;
let stack: string[] = [];
/** The app's gate (src/app/_layout.tsx) plus a stack of routes. */
function App() {
  st = useStore();
  const [, force] = useState(0);
  mockNav.go = (p) => { stack = [...stack, p]; force((x) => x + 1); };
  mockNav.back = () => { stack = stack.slice(0, -1); force((x) => x + 1); };
  if (!st.ready) return null;
  if (!st.profile) return <Onboarding />;
  if (!st.user) return <SignIn />;
  const R = ROUTES[stack[stack.length - 1] ?? '/'] ?? Home;
  return <><R /><NoticeToast /></>;
}
async function boot() {
  let r!: ReactTestRenderer;
  await act(async () => { r = create(<StoreProvider><App /></StoreProvider>); });
  await settle();
  return r;
}
const settle = () => act(async () => { await new Promise((res) => setTimeout(res, 20)); });
const byLabel = (r: ReactTestRenderer, l: string | RegExp) => r.root.findAll((x) => typeof x.props.onPress === 'function' && (typeof l === 'string' ? x.props.accessibilityLabel === l || x.props.title === l : l.test(String(x.props.accessibilityLabel ?? x.props.title ?? ''))));
const press = async (r: ReactTestRenderer, l: string | RegExp) => { const m = byLabel(r, l); if (!m.length) throw new Error(`no ${l} in: ${texts(r).slice(0, 400)}`); await act(async () => { m[0].props.onPress(); }); await settle(); };
const pressText = async (r: ReactTestRenderer, s: string) => {
  const m = r.root.findAll((x) => typeof x.props.onPress === 'function' && x.findAll((y) => typeof y.type === 'string' && [y.props.children].flat().includes(s)).length > 0);
  if (!m.length) throw new Error(`no "${s}"`); await act(async () => { m[m.length - 1].props.onPress(); }); await settle();
};
const input = (r: ReactTestRenderer, l: RegExp) => r.root.findAll((x) => x.type === TextInput && l.test(String(x.props.accessibilityLabel ?? x.props.placeholder ?? '')))[0];
const type = async (r: ReactTestRenderer, l: RegExp, v: string) => { await act(async () => { input(r, l).props.onChangeText(v); }); await settle(); };
const texts = (r: ReactTestRenderer) => r.root.findAll((x) => typeof x.type === 'string').flatMap((x) => [x.props.children].flat()).filter((c) => typeof c === 'string').join('|');
const GENERIC = /Something went wrong|Unexpected error|Network request failed|Try again later/;

const g = global as unknown as { fetch: unknown };
let fetchMock: jest.Mock;
beforeEach(() => {
  mockSaved = null; stack = [];
  fetchMock = jest.fn(() => Promise.reject(new TypeError('Network request failed')));
  g.fetch = fetchMock;
});

test('offline, no API URL: onboarding → Home → Log food → My foods → timeline, then a restart keeps it all', async () => {
  jest.useRealTimers();
  let r = await boot();
  // onboarding (2 steps) and the mock sign-in, all on the phone
  expect(texts(r)).toContain('What’s your goal?');
  await pressText(r, 'Next');
  await pressText(r, 'Start logging');
  expect(st.profile?.kcalTarget).toBeGreaterThan(0);
  await pressText(r, 'Continue with Google (mock)');
  expect(st.user?.id).toBe('mock-user');
  expect(texts(r)).toMatch(/kcal left/);

  // Log food: search, item sheet, Add, Log
  await press(r, 'Log food');
  await type(r, /Search food/, 'roti');
  await pressText(r, 'Roti');
  await press(r, /^Add 1 roti/);
  await press(r, /^Log 1 item/);
  expect(st.entries.filter(counted).map((e) => e.dish_id)).toEqual(['roti']);
  expect(texts(r)).toContain('110| eaten');

  // My foods: "Add your own food" on a no-match search, then the list
  await press(r, 'Log food');
  await type(r, /Search food/, 'kokum sherbet');
  await press(r, 'Millilitres');
  await type(r, /^Calories for 250 ml/, '120');
  await type(r, /^Protein/, '0');
  await press(r, /^Save and add/);
  await press(r, /^Log 1 item/);
  expect(st.myFoods.map((f) => f.name)).toEqual(['Kokum sherbet']);
  await press(r, 'Log food');
  await press(r, 'My foods');
  expect(texts(r)).toContain('Kokum sherbet');
  await press(r, 'Back'); await press(r, 'Back');

  // the timeline: one block, edit (2 roti), remove + Undo
  await act(async () => { mockNav.go('/food'); }); await settle();
  expect(texts(r)).toContain('230');
  await press(r, /Open$/);
  await press(r, /^Roti, 1 piece, 110 calories\. Edit$/);
  await press(r, 'More');
  await press(r, /^Update Roti/);
  await press(r, 'Remove Kokum sherbet');
  expect(texts(r)).toContain('Removed Kokum sherbet');
  await press(r, 'Undo');
  const live = () => st.entries.filter(counted).map((e) => [e.custom_name || e.dish_id, e.kcal.best]).sort();
  expect(live()).toEqual([['Kokum sherbet', 120], ['roti', 220]]);
  expect(texts(r)).toContain('340');
  expect(texts(r)).not.toMatch(GENERIC);
  const queued = st.queue.length;
  await act(async () => { r.unmount(); });

  // restart: a new store from what was saved on the phone
  stack = ['/food'];
  r = await boot();
  expect(st.user?.id).toBe('mock-user');
  expect(live()).toEqual([['Kokum sherbet', 120], ['roti', 220]]);
  expect(st.myFoods.map((f) => f.name)).toEqual(['Kokum sherbet']);
  expect(st.queue.length).toBe(queued); // still waiting for a server, never dropped
  expect(texts(r)).toContain('340');
  expect(texts(r)).toContain('Kokum sherbet');
  expect(texts(r)).not.toMatch(GENERIC);
  // no API URL: nothing ever needed the network
  expect(fetchMock).not.toHaveBeenCalled();
  await act(async () => { r.unmount(); });
}, 30000);
