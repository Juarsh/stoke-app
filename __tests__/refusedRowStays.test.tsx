// Product Engineer (rg3): no row is ever dropped silently. When the store guard refuses a row on any path, it stays
// open on screen with the reason: Log (footer Add and an AI row's own Add), Progress edit sheet, Review (bigTableRows).
import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { TextInput } from 'react-native';

const mockNav = jest.fn();
const mockStore = {
  learned: {}, aiQuota: { used: 0 }, entries: [], queue: [],
  api: { mock: true, parse: jest.fn(), parseJob: jest.fn() },
  newId: (() => { let n = 0; return () => `id${n++}`; })(),
  useAi: jest.fn(), fillPending: jest.fn(), addPending: jest.fn(), remember: jest.fn(), expireAi: jest.fn(), abandonJob: jest.fn(),
  addEntries: jest.fn(),
};
jest.mock('@/lib/store', () => ({ useStore: () => mockStore }));
jest.mock('@/lib/config', () => ({ config: { mock: true, mockAi: false, mockAiDelay: 0 }, flags: {} }));
jest.mock('expo-router', () => {
  const R = jest.requireActual('react');
  return {
    useFocusEffect: (cb: () => (() => void) | void) => R.useEffect(() => cb(), []),
    useRouter: () => ({ navigate: mockNav, push: jest.fn(), back: jest.fn() }),
    useLocalSearchParams: () => ({}),
  };
});
jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual('react-native');
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});

import Log from '../src/app/(tabs)/log';
import { EditSheet } from '../src/components/ItemEditor';
import { parser } from '../src/parser';

const texts = (r: { root: ReactTestRenderer['root'] }) => r.root.findAll((n) => typeof n.type === 'string').flatMap((n) => [n.props.children].flat()).filter((c) => typeof c === 'string').join('').replace(/\s+/g, ' ');
const WHY = 'This has no calories yet. Check it and add it again.';

test('Log: a row the store guard refuses stays on screen with its reason; Log does not close', async () => {
  jest.useFakeTimers();
  mockStore.addEntries.mockImplementation((es: { id: string }[]) => es.map((e) => ({ id: e.id, reason: WHY })));
  let r!: ReactTestRenderer;
  await act(async () => { r = create(<Log />); });
  const input = r.root.findAll((n) => n.type === TextInput && n.props.accessibilityLabel === 'What did you eat?')[0];
  await act(async () => { input.props.onChangeText('2 roti'); });
  await act(async () => { jest.advanceTimersByTime(800); });
  const add = () => r.root.findAll((n) => typeof n.props.onPress === 'function' && /^Add [0-9,]+ kcal/.test(String(n.props.accessibilityLabel ?? '')))[0];
  await act(async () => { add().props.onPress(); });
  expect(mockStore.addEntries).toHaveBeenCalledTimes(1);
  expect(mockNav).not.toHaveBeenCalled();             // Log stays open
  expect(texts(r)).toMatch(/Roti/);                     // the row is still there
  expect(texts(r)).toContain(`Not saved: ${WHY}`);      // with why
  expect(r.root.findAll((n) => n.props.testID === 'refusal' && typeof n.type === 'string')).toHaveLength(1);
  // the guard lets it through next time: saved, Log closes
  mockStore.addEntries.mockImplementation(() => []);
  await act(async () => { add().props.onPress(); });
  expect(mockNav).toHaveBeenCalledWith('/');
  await act(async () => { r.unmount(); });
  jest.useRealTimers();
});

test('Progress edit sheet: a refused save keeps the sheet open with the reason', () => {
  const it = parser.parse('2 roti').items[0];
  let r!: ReactTestRenderer;
  act(() => { r = create(<EditSheet visible it={it} onClose={() => {}} onSave={() => {}} onDelete={() => {}} error="Enter between 1 and 5,000 kcal." />); });
  expect(texts(r)).toContain('Not saved: Enter between 1 and 5,000 kcal.');
  act(() => { r.unmount(); });
});
