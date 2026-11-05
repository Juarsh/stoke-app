// Data-layer seam (architecture rule, spec-frozen-v1): everything the app keeps on the phone goes through LocalStore.
// Today's impl is the key-value store in ./kv (expo-sqlite kv-store on native, localStorage for web QA). Moving to
// another local database means a new LocalStore impl here; callers don't change. The server side is reached only
// through the API client in ./api (base URL from config.apiUrl, one config value).
import type { Api, CoachAskResponse, CoachChatTurn, CoachPickRow } from './api';
import { coachPicks, type Suggestion } from './coach';
import type { Diet } from './domain';
import { kv } from './kv';
import { DISHES } from '../parser';

export interface LocalStore {
  load(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
}

export const localStore: LocalStore = {
  load: (key) => kv.get(key),
  save: async (key, value) => { await kv.set(key, value); },
};

/** Chat history for Ask Coach (last 20 kept on the phone). */
export const COACH_CHAT_KEY = 'stoke.coach.chat.v1';
export const COACH_CHAT_KEEP = 20;
export const COACH_CHAT_SEND = 6;
export const COACH_SIGNIN_NOTE = 'Sign in to ask Coach a question.';
export const SUGGESTED_QUESTIONS = [
  "What can I eat with what's left today?",
  'How did my workouts go this week?',
  'Which habit should I focus on?',
];

export type { CoachAskResponse, CoachChatTurn, CoachPickRow };

export type CoachStoredMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  source?: 'ai' | 'rules';
  reason?: string;
  picks?: CoachPickRow[];
};

function isStoredMessage(x: unknown): x is CoachStoredMessage {
  if (!x || typeof x !== 'object') return false;
  const m = x as CoachStoredMessage;
  return (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && typeof m.id === 'string';
}

/** Keep the newest `keep` messages (default 20). */
export function clipCoachMessages<T>(msgs: T[], keep = COACH_CHAT_KEEP): T[] {
  return msgs.length > keep ? msgs.slice(-keep) : msgs;
}

/** Last `n` stored turns as the POST /v1/coach `messages` payload (default 6). */
export function coachTurnsForAsk(msgs: CoachStoredMessage[], n = COACH_CHAT_SEND): CoachChatTurn[] {
  return msgs.slice(-n).map((m) => ({ role: m.role, text: m.text }));
}

export async function loadCoachChat(store: LocalStore = localStore): Promise<CoachStoredMessage[]> {
  try {
    const raw = await store.load(COACH_CHAT_KEY);
    if (!raw) return [];
    const j = JSON.parse(raw) as unknown;
    if (!Array.isArray(j)) return [];
    return clipCoachMessages(j.filter(isStoredMessage));
  } catch {
    return [];
  }
}

export async function saveCoachChat(msgs: CoachStoredMessage[], store: LocalStore = localStore): Promise<CoachStoredMessage[]> {
  const kept = clipCoachMessages(msgs);
  await store.save(COACH_CHAT_KEY, JSON.stringify(kept));
  return kept;
}

/** Call the API client's POST /v1/coach with the last 6 stored turns (not the new question). */
export function askCoach(api: Pick<Api, 'askCoach'>, question: string, history: CoachStoredMessage[]): Promise<CoachAskResponse> {
  return api.askCoach(question.trim(), coachTurnsForAsk(history));
}

/** Only a signed-in, online, non-local session may hit the server. Expo Go testers are signed out. */
export function canAskCoach(s: { signedIn: boolean; offline?: boolean; local?: boolean }): boolean {
  return !!s.signedIn && !s.offline && !s.local;
}

export function coachReasonNote(reason?: string): string {
  switch (reason) {
    case 'over_cap':
      return "You've reached today's question limit.";
    case 'timeout':
    case 'ai_error':
      return 'AI is busy right now.';
    case 'unavailable':
      return "AI isn't available right now.";
    default:
      return "Here are picks that fit what's left today.";
  }
}

/** Map a server pick onto a table Suggestion so Log can one-tap the same way as local picks. */
export function suggestionFromPick(p: CoachPickRow): Suggestion | null {
  const dish = DISHES.find((d) => d.id === p.dish_id);
  if (!dish) return null;
  const qty = Number(p.qty) || 1;
  return { dish, qty, kcal: Math.round(Number(p.kcal) || 0), protein: Number(p.protein) || 0, label: p.label || `${qty} ${p.name}` };
}

export function localCoachPicks(kcalLeft: number, proteinLeft: number, diet: Diet, n = 3): Suggestion[] {
  return coachPicks(DISHES, kcalLeft, proteinLeft, diet, n);
}
