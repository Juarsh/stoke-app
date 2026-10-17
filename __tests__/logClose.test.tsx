// Leaving Log (the screen losing focus / unmounting) really saves open items as needs_review.
import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { TextInput } from 'react-native';

const mockStore = {
  learned: {}, aiUsed: {}, entries: [], queue: [],
  api: { mock: true, parse: jest.fn(), parseJob: jest.fn() },
  newId: (() => { let n = 0; return () => `id${n++}`; })(),
  useAi: jest.fn(), fillPending: jest.fn(), addPending: jest.fn(), addEntries: jest.fn(), remember: jest.fn(), expireAi: jest.fn(),
};
jest.mock('@/lib/store', () => ({ useStore: () => mockStore }));
jest.mock('@/lib/config', () => ({ config: { mock: true, mockAi: true, mockAiDelay: 0 }, flags: {} }));
jest.mock('expo-router', () => {
  const R = jest.requireActual('react');
  return {
    useFocusEffect: (cb: () => (() => void) | void) => R.useEffect(() => cb(), []),
    useRouter: () => ({ navigate: jest.fn(), push: jest.fn(), back: jest.fn() }),
    useLocalSearchParams: () => ({}),
  };
});
jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual('react-native');
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});

import Log from '../src/app/(tabs)/log';
import { counted, toReview } from '../src/lib/domain';
import { parser } from '../src/parser';

test('close Log with an open unit_mismatch and an AI estimate -> both saved as needs_review', async () => {
  jest.useFakeTimers();
  const text = '8 plates momos, thukpa';
  const thukpa = { ...parser.unknown('thukpa'), name: 'thukpa', ai_estimate: true, source: 'ai_estimate', needs_confirmation: true,
    kcal: { low: 220, best: 290, high: 380 }, protein_g: { low: 8, best: 10, high: 12 }, span_start: 16, span_end: 22 };
  mockStore.api.parse.mockResolvedValue({ items: [thukpa], unmatched: [], fallback: 'used', custom_items: [], used_ai: true });
  let r!: ReactTestRenderer;
  await act(async () => { r = create(<Log />); });
  const input = r.root.findAll((n) => n.type === TextInput && n.props.accessibilityLabel === 'What did you eat?')[0];
  await act(async () => { input.props.onChangeText(text); });
  await act(async () => { jest.advanceTimersByTime(700); });   // debounce -> AI call
  await act(async () => { await Promise.resolve(); });          // answer lands
  expect(mockStore.api.parse).toHaveBeenCalled();
  expect(mockStore.addEntries).not.toHaveBeenCalled();
  await act(async () => { r.unmount(); });                      // user leaves Log without choosing
  const saved = mockStore.addEntries.mock.calls.flat(2);
  expect(saved.map((e: { custom_name?: string; dish_id?: string | null; review_item?: { name: string } }) => e.review_item?.name).sort()).toEqual(['momos', 'thukpa'].sort());
  for (const e of saved) { expect(toReview(e)).toBe(true); expect(counted(e)).toBe(false); }
  jest.useRealTimers();
});
