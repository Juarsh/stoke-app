// Only the entry whose change could not be synced shows "Couldn’t sync this. Tap to retry"; tapping retries it.
import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { DISH_TABLE_VERSION } from '../src/parser';
import { localDate } from '../src/lib/domain';

const day = localDate();
const e = (id: string, name: string, kcal: number, sync_error?: string, sync_retrying?: boolean) => ({ id, local_date: day, slot: 'lunch', raw_text: name, dish_id: null, custom_name: name, qty: 1, unit: 'count', oil_level: '',
  kcal: { low: kcal, best: kcal, high: kcal }, protein_g: { low: 0, best: 0, high: 0 }, source: 'custom', source_note: '', confirmed: true, dish_table_version: DISH_TABLE_VERSION,
  created_at: '', updated_at: '', deleted_at: null, ...(sync_error ? { sync_error } : {}), ...(sync_retrying ? { sync_retrying } : {}) });
const mockStore: { entries: ReturnType<typeof e>[]; [k: string]: unknown } = { entries: [e('a', 'poha', 300, 'sync_conflict'), e('b', 'dal', 200)], queue: [], steps: {}, profile: null, user: null, retrySync: jest.fn() };
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
  expect(rows[0].props.accessibilityLabel).toBe('Lunch · poha: couldn’t sync this. Tap to retry');
  const texts = r.root.findAll((n) => n.props.children === 'Couldn’t sync this. Tap to retry');
  expect(texts.length).toBeGreaterThan(0); // no ⚠ glyph: the sync icon instead
  expect(r.root.findAll((n) => typeof n.props.children === 'string' && n.props.children.includes('⚠'))).toHaveLength(0);
  expect(r.root.findAll((n) => n.props.testID === 'sync-retry-spinner')).toHaveLength(0);
  await act(async () => { rows[0].props.onPress(); });
  expect(mockStore.retrySync).toHaveBeenCalledWith('a');
  await act(async () => { r.unmount(); });
});

const ringEaten = (r: ReactTestRenderer) => r.root.findAll((n) => typeof n.props.eaten === 'number' && 'kcalLeft' in n.props)[0].props.eaten;
test('Today: while retrying the row shows a spinner, is busy and not tappable; its kcal still counts in the ring', async () => {
  mockStore.entries = [e('a', 'poha', 300, undefined, true), e('b', 'dal', 200)];
  (mockStore.retrySync as jest.Mock).mockClear();
  let r!: ReactTestRenderer;
  await act(async () => { r = create(<Today />); });
  const row = r.root.find((n) => n.props.accessibilityLabel === 'Lunch · poha: retrying sync' && n.props.accessibilityRole === 'button');
  expect(row.props.accessibilityState).toMatchObject({ busy: true, disabled: true });
  expect(r.root.findAll((n) => n.props.testID === 'sync-retry-spinner').length).toBeGreaterThan(0);
  expect(r.root.findAll((n) => n.props.children === 'Retrying…').length).toBeGreaterThan(0);
  expect(row.props.onPress).toBeFalsy();
  expect(mockStore.retrySync).not.toHaveBeenCalled();
  expect(ringEaten(r)).toBe(500); // poha (retrying) + dal
  await act(async () => { r.unmount(); });
});
test('Today: a failed row still counts in the totals (ring + plate), a failed delete does not', async () => {
  mockStore.entries = [e('a', 'poha', 300, 'sync_conflict'), e('b', 'dal', 200)];
  let r!: ReactTestRenderer;
  await act(async () => { r = create(<Today />); });
  expect(ringEaten(r)).toBe(500);
  expect(r.root.findAll((n) => typeof n.props.accessibilityLabel === 'string' && /^Lunch: .*500 calories$/.test(n.props.accessibilityLabel)).length).toBeGreaterThan(0);
  await act(async () => { r.unmount(); });
  mockStore.entries = [{ ...e('a', 'poha', 300, 'http_403'), deleted_at: '2026-10-17T05:00:00Z' } as never, e('b', 'dal', 200)];
  await act(async () => { r = create(<Today />); });
  expect(ringEaten(r)).toBe(200);
  expect(r.root.findAll((n) => n.props.accessibilityLabel === 'Lunch · poha (deleted): couldn’t sync this. Tap to retry').length).toBeGreaterThan(0);
  await act(async () => { r.unmount(); });
});
test('the sync-failed row is at least 44 px tall and the 13 px line uses the warn token', () => {
  const { SyncFailedRow } = jest.requireActual('../src/components/SyncFailedRow');
  const { palette } = jest.requireActual('../src/theme/tokens');
  const { StyleSheet } = jest.requireActual('react-native');
  let r!: ReactTestRenderer;
  act(() => { r = create(<SyncFailedRow title="Lunch · poha" kcal={300} retrying={false} onRetry={() => {}} />); });
  const btn = r.root.find((n) => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function');
  expect(StyleSheet.flatten(btn.props.style).minHeight).toBeGreaterThanOrEqual(44);
  const st = r.root.findAll((n) => n.props.children === 'Couldn’t sync this. Tap to retry').map((n) => StyleSheet.flatten(n.props.style)).find((x) => x?.color);
  expect(st.fontSize).toBe(13);
  expect([palette.light.warn, palette.dark.warn]).toContain(st.color);
  act(() => { r.unmount(); });
});
test('rg4 (a): a refused PATCH shows the server\'s reason under the retry line, and in the label', () => {
  const { SyncFailedRow } = jest.requireActual('../src/components/SyncFailedRow');
  let r!: ReactTestRenderer;
  act(() => { r = create(<SyncFailedRow title="Lunch · wedding plate" kcal={6000} retrying={false} onRetry={() => {}} reason="this item needs kcal (0-5000)" />); });
  expect(r.root.find((n) => n.props.testID === 'sync-reason').props.children).toBe('this item needs kcal (0-5000)');
  expect(r.root.findAll((n) => n.props.accessibilityLabel === 'Lunch · wedding plate: couldn’t sync this. Tap to retry. this item needs kcal (0-5000)').length).toBeGreaterThan(0);
  act(() => { r.update(<SyncFailedRow title="Lunch · wedding plate" kcal={6000} retrying onRetry={() => {}} reason="this item needs kcal (0-5000)" />); });
  expect(r.root.findAll((n) => n.props.testID === 'sync-reason')).toHaveLength(0);
  act(() => { r.unmount(); });
});
