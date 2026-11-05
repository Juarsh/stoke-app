// Ask Coach data seam: persistence cap, last-6 payload, reason notes, and the API client call.
import { createApi, type CoachChatTurn } from '../src/lib/api';
import {
  askCoach, canAskCoach, clipCoachMessages, coachReasonNote, coachTurnsForAsk,
  COACH_CHAT_KEEP, COACH_SIGNIN_NOTE, loadCoachChat, saveCoachChat, suggestionFromPick,
  type CoachStoredMessage,
} from '../src/lib/data';
import { DISHES } from '../src/parser';

const mem = new Map<string, string>();
const store = { load: async (k: string) => mem.get(k) ?? null, save: async (k: string, v: string) => { mem.set(k, v); } };
const msg = (i: number, role: 'user' | 'assistant' = 'user'): CoachStoredMessage => ({ id: `m${i}`, role, text: `t${i}` });

beforeEach(() => { mem.clear(); });

test('clipCoachMessages keeps the last 20', () => {
  const all = Array.from({ length: 25 }, (_, i) => msg(i));
  const kept = clipCoachMessages(all);
  expect(kept).toHaveLength(COACH_CHAT_KEEP);
  expect(kept[0].id).toBe('m5');
  expect(kept[19].id).toBe('m24');
});

test('saveCoachChat persists at most 20 messages', async () => {
  const all = Array.from({ length: 21 }, (_, i) => msg(i));
  const kept = await saveCoachChat(all, store);
  expect(kept).toHaveLength(20);
  expect(kept[0].text).toBe('t1');
  const loaded = await loadCoachChat(store);
  expect(loaded.map((m) => m.id)).toEqual(kept.map((m) => m.id));
});

test('coachTurnsForAsk sends the last 6', () => {
  const all = Array.from({ length: 8 }, (_, i) => msg(i, i % 2 ? 'assistant' : 'user'));
  const turns = coachTurnsForAsk(all);
  expect(turns).toHaveLength(6);
  expect(turns[0]).toEqual({ role: 'user', text: 't2' });
  expect(turns[5]).toEqual({ role: 'assistant', text: 't7' });
});

test('canAskCoach is only true when signed in, online, and not local', () => {
  expect(canAskCoach({ signedIn: false, offline: false, local: false })).toBe(false);
  expect(canAskCoach({ signedIn: true, offline: true, local: false })).toBe(false);
  expect(canAskCoach({ signedIn: true, offline: false, local: true })).toBe(false);
  expect(canAskCoach({ signedIn: true, offline: false, local: false })).toBe(true);
});

test('coachReasonNote maps server reasons', () => {
  expect(coachReasonNote('over_cap')).toMatch(/limit/i);
  expect(coachReasonNote('timeout')).toMatch(/busy/i);
  expect(coachReasonNote('ai_error')).toMatch(/busy/i);
  expect(COACH_SIGNIN_NOTE).toMatch(/Sign in/i);
});

test('suggestionFromPick maps a table dish', () => {
  const d = DISHES.find((x) => !x.needs_verification && x.kcal > 0)!;
  const s = suggestionFromPick({ dish_id: d.id, name: d.name, qty: 1, unit: d.unit, kcal: Math.round(d.kcal), protein: d.protein_g, label: `1 ${d.name}` });
  expect(s?.dish.id).toBe(d.id);
  expect(suggestionFromPick({ dish_id: 'no-such-dish', name: 'x', qty: 1, unit: 'count', kcal: 1, protein: 1, label: 'x' })).toBeNull();
});

test('askCoach forwards the last 6 turns to the API client', async () => {
  const seen: { q?: string; m?: CoachChatTurn[] } = {};
  const api = { askCoach: jest.fn(async (q: string, m: CoachChatTurn[] = []) => { seen.q = q; seen.m = m; return { answer: 'ok', source: 'ai' as const }; }) };
  const history = Array.from({ length: 8 }, (_, i) => msg(i, i % 2 ? 'assistant' : 'user'));
  await askCoach(api, '  What next?  ', history);
  expect(seen.q).toBe('What next?');
  expect(seen.m).toHaveLength(6);
  expect(seen.m![0].text).toBe('t2');
});
