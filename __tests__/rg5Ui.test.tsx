// Tester rg5 / Designer (Oct 17), on screen: an amount change that takes an AI row past a server limit (protein > 300,
// kcal > 5000) is refused on the sheet with "That’s too much for one entry. Try a smaller amount." and Save disabled; an
// Add / Save that can't save uses the disabled look (coral fill at 40%), never the enabled one.
import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { StyleSheet, TextInput } from 'react-native';

jest.mock('../src/lib/config', () => ({ config: { mock: true, mockAi: false, mockAiDelay: 0 }, flags: {} }));
let mockSaved: string | null = null;
jest.mock('../src/lib/kv', () => ({ kv: { get: async () => mockSaved, set: async (_k: string, v: string) => { mockSaved = v; } } }));
let mockN = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `id${++mockN}` }));
jest.mock('expo-router', () => {
  const R = jest.requireActual('react');
  return { useFocusEffect: (cb: () => (() => void) | void) => R.useEffect(() => cb(), []), useRouter: () => ({ navigate: jest.fn(), push: jest.fn(), back: jest.fn(), replace: jest.fn() }), useLocalSearchParams: () => ({}) };
});
jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual('react-native');
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});

import { EditSheet } from '../src/components/ItemEditor';
import { StoreProvider, Store, useStore } from '../src/lib/store';
import { counted, TOO_MUCH_REASON } from '../src/lib/domain';
import { parser, Item } from '../src/parser';
import { palette } from '../src/theme/tokens';
import Log from '../src/app/(tabs)/log';

jest.setTimeout(30_000);
const texts = (r: ReactTestRenderer) => r.root.findAll((n) => typeof n.type === 'string').flatMap((n) => [n.props.children].flat()).filter((c) => typeof c === 'string') as string[];
const textOf = (r: ReactTestRenderer) => texts(r).join('').replace(/\s+/g, ' ');
/** the host view of a Button by its title, its flattened style and disabled state */
const button = (r: ReactTestRenderer, title: string | RegExp) => {
  const host = r.root.findAll((n) => typeof n.type === 'string' && n.props.accessibilityRole === 'button'
    && r.root.findAll(() => false) && texts({ root: n } as unknown as ReactTestRenderer).some((t) => (typeof title === 'string' ? t === title : title.test(t))));
  const h = host[host.length - 1];
  if (!h) throw new Error(`no button ${title}: ${texts(r).join(' | ')}`);
  return { node: h, style: StyleSheet.flatten(typeof h.props.style === 'function' ? h.props.style({ pressed: false }) : h.props.style) as { backgroundColor?: string; opacity?: number }, disabled: !!h.props.accessibilityState?.disabled };
};
const ai = (kcal: number, protein: number): Item => ({ ...parser.unknown('zorbali shake'), name: 'zorbali shake', matched_text: '1 glass zorbali shake', source: 'ai_estimate', data_source: 'ai', ai_estimate: true,
  quantity: 1, unit: 'glass', kcal: { low: kcal, best: kcal, high: kcal }, protein_g: { low: protein, best: protein, high: protein }, needs_confirmation: false } as Item);
const pressLabel = async (r: ReactTestRenderer, label: string, times = 1) => {
  for (let i = 0; i < times; i++) { const b = r.root.findAll((n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0]; await act(async () => { b.props.onPress(); }); }
};

describe('edit sheet: past a server limit is refused on the sheet, nothing is sent', () => {
  test('zorbali shake 120 g protein x3 (360 g): the message, Save disabled in the coral 40% look; back to x2.5 (300 g) saves', async () => {
    const onSave = jest.fn();
    let r!: ReactTestRenderer;
    await act(async () => { r = create(<EditSheet visible it={ai(300, 120)} onClose={() => {}} onSave={onSave} onDelete={() => {}} />); });
    await pressLabel(r, 'Increase', 4); // 1 -> 3
    expect(textOf(r)).toContain('360 g protein');
    expect(textOf(r)).toContain(TOO_MUCH_REASON); expect(TOO_MUCH_REASON).toBe('That’s too much for one entry. Try a smaller amount.');
    let save = button(r, 'Save changes');
    expect(save.disabled).toBe(true); expect(save.style).toMatchObject({ backgroundColor: palette.light.accentFill, opacity: 0.4 });
    await act(async () => { r.root.findAll((n) => n.props.title === 'Save changes')[0].props.onPress(); }); // forced
    expect(onSave).not.toHaveBeenCalled();
    await pressLabel(r, 'Decrease'); // 2.5 -> 300 g, the server's max
    expect(textOf(r)).not.toContain(TOO_MUCH_REASON);
    save = button(r, 'Save changes');
    expect(save.disabled).toBe(false); expect(save.style.opacity).toBeUndefined();
    await act(async () => { r.root.findAll((n) => n.props.title === 'Save changes')[0].props.onPress(); });
    expect(onSave).toHaveBeenCalledTimes(1); expect(onSave.mock.calls[0][0].protein_g.best).toBe(300);
    await act(async () => { r.unmount(); });
  });
  test('AI 2000 x3 = 6000: the same message (not the typed-kcal one), Save disabled', async () => {
    const onSave = jest.fn();
    let r!: ReactTestRenderer;
    await act(async () => { r = create(<EditSheet visible it={ai(2000, 20)} onClose={() => {}} onSave={onSave} onDelete={() => {}} />); });
    await pressLabel(r, 'Increase', 4);
    expect(textOf(r)).toContain(TOO_MUCH_REASON); expect(textOf(r)).not.toContain('Enter between 1 and 5,000 kcal.');
    expect(button(r, 'Save changes').disabled).toBe(true);
    await act(async () => { r.unmount(); });
  });
});

let st!: Store;
function Probe() { st = useStore(); return null; }
test('Log "5001 roti" -> pick 5001: Add shows disabled (coral 40%), a press saves nothing', async () => {
  mockSaved = JSON.stringify({ user: { id: 'u', name: 'A', email: 'a@x', idToken: null, mock: true }, entries: [], queue: [], aiQuota: { used: 0 },
    profile: { goal: 'maintain', sex: 'm', age: 30, heightCm: 172, weightKg: 68, activity: 'light', diet: 'veg', kcalTarget: 2350, proteinTarget: 82, stepsTarget: 8000, addStepKcal: false, showKcalOnCards: true } });
  let r!: ReactTestRenderer;
  await act(async () => { r = create(<StoreProvider><Probe /><Log /></StoreProvider>); });
  await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
  const input = r.root.findAll((n) => n.type === TextInput && n.props.accessibilityLabel === 'What did you eat?')[0];
  await act(async () => { input.props.onChangeText('5001 roti'); });
  await act(async () => { await new Promise((res) => setTimeout(res, 800)); });
  const pick = r.root.findAll((n) => typeof n.props.onPress === 'function' && /5,?001 pieces/.test(String(n.props.accessibilityLabel ?? '')));
  await act(async () => { pick[pick.length - 1].props.onPress(); });
  expect(textOf(r)).toContain('Enter an amount between 0.5 and 5,000.');
  const add = button(r, /^Add /);
  expect(add.disabled).toBe(true); expect(add.style).toMatchObject({ backgroundColor: palette.light.accentFill, opacity: 0.4 });
  await act(async () => { add.node.props.onPress?.(); });
  expect(st.entries.filter(counted)).toEqual([]);
  await act(async () => { r.unmount(); });
});
