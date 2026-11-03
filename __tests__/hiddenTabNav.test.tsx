// expo-router 58: a Tabs.Screen with href: null is now "hidden" and can't be navigated to; router.push('/coach') or
// '/log' silently did nothing (Ask Coach in the + sheet, Coach's Log fallback, Home's prefilled /log pushes, Summary's
// Ask Coach). Renders the real (tabs) layout, TabBar and + sheet with stand-in screens.
import React from 'react';
import { Pressable, Text } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { renderRouter, screen, act } from 'expo-router/testing-library';
import { fireEvent } from '@testing-library/react-native';

jest.mock('@/lib/plans', () => ({ usePlans: () => ({ state: { plans: [], activeId: null } }) }));
jest.mock('@/lib/workouts', () => ({ useWorkouts: () => ({ active: null, start: jest.fn(), startEmpty: jest.fn() }) }));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TabsLayout = require('../src/app/(tabs)/_layout').default;

function Home() {
  const r = useRouter();
  return (<>
    <Text>home screen</Text>
    <Pressable testID="coach" onPress={() => r.push('/coach')}><Text>c</Text></Pressable>
    <Pressable testID="log" onPress={() => r.push({ pathname: '/log', params: { prefill: 'dal' } })}><Text>l</Text></Pressable>
  </>);
}
function Log() { const p = useLocalSearchParams<{ prefill?: string }>(); return <Text>log screen {p.prefill ?? ''}</Text>; }
const routes = {
  _layout: () => <Stack screenOptions={{ headerShown: false }}><Stack.Screen name="(tabs)" /></Stack>,
  '(tabs)/_layout': TabsLayout,
  '(tabs)/index': Home,
  '(tabs)/food': () => <Text>food screen</Text>,
  '(tabs)/train': () => <Text>train screen</Text>,
  '(tabs)/progress': () => <Text>progress screen</Text>,
  '(tabs)/coach': () => <Text>coach screen</Text>,
  '(tabs)/log': Log,
  '(tabs)/community': () => <Text>community screen</Text>,
  summary: () => <Text>summary</Text>,
};
const press = async (el: Parameters<typeof fireEvent.press>[0]) => { await act(async () => { fireEvent.press(el); }); };

it('Home -> /coach opens Coach', async () => {
  await renderRouter(routes);
  await press(screen.getByTestId('coach'));
  expect(screen).toHavePathname('/coach');
  expect(screen.getByText('coach screen')).toBeTruthy();
});
it('a prefilled /log push opens Log with the text', async () => {
  await renderRouter(routes);
  await press(screen.getByTestId('log'));
  expect(screen).toHavePathname('/log');
  expect(screen.getByText('log screen dal')).toBeTruthy();
});
it('+ sheet -> Ask Coach opens Coach', async () => {
  await renderRouter(routes);
  await press(screen.getByLabelText('Quick add'));
  // the row says what Coach does (rules-based picks), not "questions": there is no way to ask one yet
  await press(screen.getByLabelText('Ask Coach, Picks that fit what’s left today'));
  expect(screen).toHavePathname('/coach');
});
it('the tab bar still switches tabs (also one not visited yet), and hidden routes stay out of it', async () => {
  await renderRouter(routes);
  expect(screen.queryByLabelText('Coach')).toBeNull();
  await press(screen.getByLabelText('Food'));
  expect(screen).toHavePathname('/food');
  await press(screen.getByLabelText('Progress'));
  expect(screen).toHavePathname('/progress');
  await press(screen.getByLabelText('Home'));
  expect(screen).toHavePathname('/');
});
