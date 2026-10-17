// Only the entry whose change could not be synced shows "Couldn’t sync this. Tap to retry"; tapping retries it.
import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { DISH_TABLE_VERSION } from '../src/parser';
import { localDate } from '../src/lib/domain';

const day = localDate();
const e = (id: string, name: string, kcal: number, sync_error?: string) => ({ id, local_date: day, slot: 'lunch', raw_text: name, dish_id: null, custom_name: name, qty: 1, unit: 'count', oil_level: '',
  kcal: { low: kcal, best: kcal, high: kcal }, protein_g: { low: 0, best: 0, high: 0 }, source: 'custom', source_note: '', confirmed: true, dish_table_version: DISH_TABLE_VERSION,
  created_at: '', updated_at: '', deleted_at: null, ...(sync_error ? { sync_error } : {}) });
const mockStore = { entries: [e('a', 'poha', 300, 'sync_conflict'), e('b', 'dal', 200)], queue: [], steps: {}, profile: null, user: null, retrySync: jest.fn() };
jest.mock('@/lib/store', () => ({ useStore: () => mockStore }));
jest.mock('expo-router', () => ({ useRouter: () => ({ navigate: jest.fn(), push: jest.fn(), back: jest.fn() }), useFocusEffect: () => {}, useLocalSearchParams: () => ({}) }));
jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual('react-native');
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});
import Today from '../src/app/(tabs)/index';

test('Today: the failed row says so and retries on tap; the synced one does not', async () => {
  let r!: ReactTestRenderer;
  await act(async () => { r = create(<Today />); });
  const rows = r.root.findAll((n) => typeof n.props.accessibilityLabel === 'string' && /couldn’t sync this/i.test(n.props.accessibilityLabel) && typeof n.props.onPress === 'function');
  expect(rows).toHaveLength(1);
  expect(rows[0].props.accessibilityLabel).toBe('poha: couldn’t sync this. Tap to retry');
  const texts = r.root.findAll((n) => n.props.children === '⚠ Couldn’t sync this. Tap to retry');
  expect(texts.length).toBeGreaterThan(0);
  await act(async () => { rows[0].props.onPress(); });
  expect(mockStore.retrySync).toHaveBeenCalledWith('a');
  await act(async () => { r.unmount(); });
});
