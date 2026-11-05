// createApi.askCoach: POST /v1/coach with the contract, and no request when local/mock.
jest.mock('../src/lib/config', () => ({
  config: { apiUrl: 'https://stoke.test', mock: false, mockAi: false, mockAiDelay: 0, google: {} },
  flags: {},
}));

import { ASK_COACH_FETCH_MS, createApi } from '../src/lib/api';

const json = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: () => null },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

afterEach(() => { delete (global as { fetch?: unknown }).fetch; });

test('askCoach POSTs /v1/coach with question and last 6 messages', async () => {
  const fetch = jest.fn().mockResolvedValue(json(200, { answer: 'Have dal.', source: 'ai' }));
  (globalThis as unknown as { fetch: typeof fetch }).fetch = fetch;
  const api = createApi(() => 'tok');
  const extra = Array.from({ length: 8 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', text: `m${i}` }));
  const got = await api.askCoach('What can I eat?', extra);
  expect(got).toEqual({ answer: 'Have dal.', source: 'ai', reason: undefined, picks: undefined });
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe('https://stoke.test/v1/coach');
  expect(init.method).toBe('POST');
  expect(init.signal).toBeDefined();
  expect(init.headers.Authorization).toBe('Bearer tok');
  const body = JSON.parse(init.body as string);
  expect(body.question).toBe('What can I eat?');
  expect(body.messages).toHaveLength(6);
  expect(body.messages[0].text).toBe('m2');
  expect(body.messages[5].text).toBe('m7');
});

test('askCoach returns a rules answer with picks', async () => {
  const picks = [{ dish_id: 'dal', name: 'dal', qty: 1, unit: 'katori', kcal: 180, protein: 8, label: '1 katori dal' }];
  (globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue(json(200, { answer: 'Limit hit.', source: 'rules', reason: 'over_cap', picks }));
  const api = createApi(() => 'tok');
  const got = await api.askCoach('Again?');
  expect(got.source).toBe('rules');
  expect(got.reason).toBe('over_cap');
  expect(got.picks).toEqual(picks);
});

test('ASK_COACH_FETCH_MS is longer than the server 15s budget', () => {
  expect(ASK_COACH_FETCH_MS).toBeGreaterThan(15_000);
});
