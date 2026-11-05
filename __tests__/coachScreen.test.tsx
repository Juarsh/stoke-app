// Coach tab: signed-out fallback, AI answer, rules picks, error fallback.
import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { TextInput } from 'react-native';

const mockKv = new Map<string, string>();
jest.mock('expo-sqlite/kv-store', () => ({
  __esModule: true,
  default: {
    getItem: async (k: string) => mockKv.get(k) ?? null,
    setItem: async (k: string, v: string) => { mockKv.set(k, v); },
  },
}));

const mockAsk = jest.fn();
const mockStore = {
  signedInGoogle: false,
  api: { mock: true, askCoach: mockAsk },
  newId: (() => { let n = 0; return () => `id${++n}`; })(),
  addEntries: jest.fn(() => []),
  deleteEntry: jest.fn(),
};
jest.mock('@/lib/store', () => ({ useStore: () => mockStore }));

const mockDay: {
  profile: { diet: 'veg' };
  kcalTarget: number; proteinTarget: number;
  tot: { kcal: number; protein: number };
  picks: { dish: { id: string; name: string; category?: string; unit: string }; qty: number; kcal: number; protein: number; label: string }[];
  offline: boolean;
} = {
  profile: { diet: 'veg' }, kcalTarget: 2000, proteinTarget: 100,
  tot: { kcal: 800, protein: 40 }, picks: [], offline: false,
};
jest.mock('@/lib/useDay', () => ({ useDay: () => mockDay }));

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }) }));
jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual('react-native');
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});

import Coach from '../src/app/(tabs)/coach';
import { COACH_CHAT_KEY, COACH_SIGNIN_NOTE, coachReasonNote } from '../src/lib/data';
import { coachPicks } from '../src/lib/coach';
import { DISHES } from '../src/parser';

const sample = coachPicks(DISHES, 520, 38, 'veg', 3);
const capName = (n: string) => n.charAt(0).toUpperCase() + n.slice(1);
const texts = (r: ReactTestRenderer) => r.root.findAll((x) => typeof x.type === 'string').flatMap((x) => [x.props.children].flat()).filter((c) => typeof c === 'string').join('|');
const byLabel = (r: ReactTestRenderer, l: string) => r.root.findAll((x) => x.props.accessibilityLabel === l);
const press = (r: ReactTestRenderer, l: string) => {
  const m = byLabel(r, l);
  if (!m.length) throw new Error(`no ${l}`);
  return act(async () => { m[0].props.onPress(); });
};
async function mount() {
  let r!: ReactTestRenderer;
  await act(async () => { r = create(<Coach />); });
  await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
  return r;
}

beforeEach(() => {
  mockKv.clear();
  mockAsk.mockReset();
  mockStore.signedInGoogle = false;
  mockStore.api.mock = true;
  mockDay.offline = false;
  mockDay.picks = sample;
  mockStore.newId = (() => { let n = 0; return () => `id${++n}`; })();
});

test('signed out shows local picks and a sign-in note, not the question box', async () => {
  const r = await mount();
  const t = texts(r);
  expect(t).toContain(COACH_SIGNIN_NOTE);
  expect(t).toContain(capName(sample[0].dish.name));
  expect(t).toContain('Picks that fit');
  expect(byLabel(r, 'Ask Coach a question')).toHaveLength(0);
  expect(mockAsk).not.toHaveBeenCalled();
  await act(async () => { r.unmount(); });
});

test('an AI answer renders', async () => {
  mockStore.signedInGoogle = true;
  mockStore.api.mock = false;
  mockAsk.mockResolvedValue({ answer: 'Have dal tonight.', source: 'ai' });
  const r = await mount();
  const input = r.root.findAll((n) => n.type === TextInput && n.props.accessibilityLabel === 'Ask Coach a question')[0];
  await act(async () => { input.props.onChangeText('What can I eat?'); });
  await press(r, 'Send question');
  await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
  expect(mockAsk).toHaveBeenCalledWith('What can I eat?', []);
  expect(texts(r)).toContain('Have dal tonight.');
  expect(texts(r)).toContain('What can I eat?');
  expect(texts(r)).not.toContain(coachReasonNote('over_cap'));
  await act(async () => { r.unmount(); });
});

test('a rules answer renders the picks and a reason note', async () => {
  mockStore.signedInGoogle = true;
  mockStore.api.mock = false;
  const p = sample[0];
  mockAsk.mockResolvedValue({
    answer: "You've asked 20 questions today.",
    source: 'rules',
    reason: 'over_cap',
    picks: [{ dish_id: p.dish.id, name: p.dish.name, qty: p.qty, unit: p.dish.unit, kcal: p.kcal, protein: p.protein, label: p.label }],
  });
  const r = await mount();
  const input = r.root.findAll((n) => n.type === TextInput && n.props.accessibilityLabel === 'Ask Coach a question')[0];
  await act(async () => { input.props.onChangeText('Again?'); });
  await press(r, 'Send question');
  await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
  const t = texts(r);
  expect(t).toContain(coachReasonNote('over_cap'));
  expect(t).toContain(capName(p.dish.name));
  expect(t).toContain("You've asked 20 questions today.");
  await act(async () => { r.unmount(); });
});

test('an error falls back to local picks without crashing', async () => {
  mockStore.signedInGoogle = true;
  mockStore.api.mock = false;
  mockAsk.mockRejectedValue(new Error('network'));
  const r = await mount();
  const input = r.root.findAll((n) => n.type === TextInput && n.props.accessibilityLabel === 'Ask Coach a question')[0];
  await act(async () => { input.props.onChangeText('Hello?'); });
  await press(r, 'Send question');
  await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
  const t = texts(r);
  expect(t).toContain(coachReasonNote('ai_error'));
  expect(t).toContain(capName(sample[0].dish.name));
  await act(async () => { r.unmount(); });
});

test('the 20-message cap is kept on disk after a long chat', async () => {
  mockStore.signedInGoogle = true;
  mockStore.api.mock = false;
  mockAsk.mockResolvedValue({ answer: 'ok', source: 'ai' });
  const prior = Array.from({ length: 19 }, (_, i) => ({ id: `old${i}`, role: i % 2 ? 'assistant' : 'user', text: `old ${i}` }));
  mockKv.set(COACH_CHAT_KEY, JSON.stringify(prior));
  const r = await mount();
  const input = r.root.findAll((n) => n.type === TextInput && n.props.accessibilityLabel === 'Ask Coach a question')[0];
  await act(async () => { input.props.onChangeText('latest'); });
  await press(r, 'Send question');
  await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
  const saved = JSON.parse(mockKv.get(COACH_CHAT_KEY) ?? '[]') as { text: string }[];
  expect(saved).toHaveLength(20);
  expect(saved[0].text).toBe('old 1');
  expect(saved[18].text).toBe('latest');
  expect(saved[19].text).toBe('ok');
  expect(texts(r)).not.toContain('old 0');
  await act(async () => { r.unmount(); });
});
