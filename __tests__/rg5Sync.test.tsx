// Tester rg5 (Oct 17), the 4xx hard-gate rule: ANY 4xx on sync (POST of a new row or a review-later draft, or PATCH),
// other than 401/404/408/409/429, keeps the phone's row and value and shows "Couldn’t sync this. Tap to retry" with the
// server's reason. Never a 0-kcal Review row, never an undone Add, no duplicate ops or rows. And the phone refuses up
// front what food.go refuses (protein 0-300, carbs / fat >= 0, AI kcal 0-5000, custom_name <= 120 bytes).
// Runs the REAL store against a fake server that follows internal/food/food.go @ 8692837 (resolve + draft + PATCH).
import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';

jest.mock('../src/lib/config', () => ({ config: { mock: false, apiUrl: 'http://api.test', mockAi: false }, flags: {} }));
let mockSaved: string | null = null;
jest.mock('../src/lib/kv', () => ({ kv: { get: async () => mockSaved, set: async (_k: string, v: string) => { mockSaved = v; } } }));
let mockN = 0;
jest.mock('expo-crypto', () => ({ randomUUID: () => `id${++mockN}` }));
jest.mock('expo-router', () => ({ useFocusEffect: () => {}, useRouter: () => ({ navigate: jest.fn(), push: jest.fn(), back: jest.fn(), replace: jest.fn() }), useLocalSearchParams: () => ({}) }));
jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual('react-native');
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});

import { StoreProvider, Store, useStore } from '../src/lib/store';
import { counted, dayTotals, entryFromItem, FoodEntry, dayOf, localDate, reviewEntry, serverName, TOO_MUCH_REASON } from '../src/lib/domain';
import { parser, DISH_TABLE_VERSION, Item } from '../src/parser';
import { parseLocal } from '../src/lib/parseLocal';
import { draftDishOk } from '../src/lib/api';
import Review from '../src/app/review';
import { SYNC_FAILED_COPY } from '../src/components/SyncFailedRow';

jest.setTimeout(30_000);
const DAY = dayOf();
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

// ---- fake server: food.go resolve / draft / handlePatch rules ----
type Row = { client_id: string; version: number; kcal: number; protein: number; state: string; source: string; dish_id: string; qty: number; unit: string; custom_name: string; deleted: boolean };
const server = {
  rows: new Map<string, Row>(), log: [] as string[], force: [] as { status: number; body: unknown; when?: (b: Record<string, unknown>) => boolean }[],
  reset() { this.rows.clear(); this.log = []; this.force = []; },
  summary() { return [...this.rows.values()].filter((r) => !r.deleted && r.state === 'confirmed').reduce((s, r) => s + r.kcal, 0); },
};
const reply = (status: number, body: unknown = {}) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const bad = (msg: string) => ({ status: 400, msg });
type It = { dish_id?: string; qty?: number; unit?: string; oil_level?: string; custom_name?: string; source?: string; state?: string; kcal?: number; protein_g?: number; carbs_g?: number; fat_g?: number };
const isTable = (it: It) => !!it.dish_id && it.source !== 'ai_estimate' && it.source !== 'custom' && it.source !== 'manual';
/** food.go resolve (+ draft for state needs_review): the saved numbers, or the 400 */
function resolve(it: It): { kcal: number; protein: number; qty: number } | { status: number; msg: string } {
  const qty = it.qty || 1;
  if (it.state === 'needs_review') {
    if (it.dish_id) {
      let r: Item; try { r = parser.recompute(it.dish_id, qty, it.unit ?? '', it.oil_level ?? ''); } catch (e) { return bad((e as Error).message); }
      if (r.kcal.best > 5000 || r.kcal.best < 0) return bad('numbers out of range');
      return { kcal: 0, protein: 0, qty };
    }
    const n = (it.custom_name ?? '').trim();
    if (!n || bytes(n) > 120) return bad('each item needs dish_id or custom_name');
    return { kcal: 0, protein: 0, qty };
  }
  if (isTable(it)) {
    let r: Item; try { r = parser.recompute(it.dish_id!, qty, it.unit ?? '', it.oil_level ?? ''); } catch (e) { return bad((e as Error).message); }
    return { kcal: it.kcal ?? r.kcal.best, protein: it.protein_g ?? r.protein_g.best, qty };
  }
  const name = (it.custom_name ?? '').trim();
  if (!name || bytes(name) > 120) return bad('each item needs dish_id or custom_name');
  if (it.kcal == null || it.kcal < 0 || it.kcal > 5000) return bad('this item needs kcal (0-5000)');
  const pr = it.protein_g ?? 0;
  if (pr < 0 || pr > 300 || (it.carbs_g ?? 0) < 0 || (it.fat_g ?? 0) < 0) return bad('protein_g, carbs_g and fat_g must be >= 0 (protein <= 300)');
  return { kcal: it.kcal, protein: pr, qty };
}
const view = (r: Row) => ({ client_id: r.client_id, version: r.version, kcal_best: r.kcal, state: r.state });
async function fakeFetch(url: string, init: { method: string; body?: string }) {
  const path = url.replace('http://api.test', ''); const b = init.body ? JSON.parse(init.body) : {};
  server.log.push(`${init.method} ${path}`);
  if (path === '/v1/remembered') return reply(200, { remembered: [] });
  const f = server.force.findIndex((x) => !x.when || x.when(init.method === 'POST' ? b.items?.[0] ?? {} : b));
  if (f >= 0 && /^\/v1\/entries/.test(path)) { const x = server.force.splice(f, 1)[0]; return reply(x.status, x.body); }
  if (init.method === 'POST' && path === '/v1/entries') {
    const it = b.items[0]; const ex = server.rows.get(it.client_id);
    if (ex && !ex.deleted) return reply(200, { entries: [view(ex)], duplicates: [it.client_id] });
    const res = resolve(it);
    if ('status' in res) return reply(res.status, { error: res.msg });
    const r: Row = { client_id: it.client_id, version: 1, kcal: res.kcal, protein: res.protein, state: it.state ?? 'confirmed', source: it.source, dish_id: it.dish_id ?? '',
      qty: res.qty, unit: it.unit ?? 'count', custom_name: (it.custom_name ?? '').trim(), deleted: false };
    server.rows.set(r.client_id, r); return reply(201, { entries: [view(r)] });
  }
  const m = /^\/v1\/entries\/(.+)$/.exec(path); const r = m && server.rows.get(decodeURIComponent(m[1]));
  if (!r || r.deleted) return reply(404, { error: 'entry not found' });
  if (init.method === 'DELETE') { r.deleted = true; r.version++; return reply(204); }
  if (b.version != null && b.version !== r.version) return reply(409, { error: { code: 'version_conflict' }, entry: view(r) });
  const dish = b.dish_id !== undefined ? b.dish_id : r.dish_id;
  const it: It = { dish_id: dish, qty: b.qty ?? r.qty, unit: b.unit ?? r.unit, oil_level: b.oil_level, custom_name: b.custom_name ?? r.custom_name, state: b.state ?? r.state,
    source: b.dish_id ? 'table' : !dish && b.kcal != null ? 'custom' : r.source, kcal: dish && b.source !== 'custom' ? undefined : (b.kcal ?? r.kcal), protein_g: b.protein_g ?? r.protein };
  const res = resolve(it);
  if ('status' in res) return reply(res.status, { error: res.msg });
  Object.assign(r, { kcal: res.kcal, protein: res.protein, qty: res.qty, state: it.state, source: it.source, dish_id: dish ?? '', custom_name: (it.custom_name ?? '').trim(), version: r.version + 1 });
  return reply(200, view(r));
}

let st!: Store;
function Probe() { st = useStore(); return null; }
const tick = async (n = 12) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((res) => setTimeout(res, 0)); }); };
const settle = async () => { for (let i = 0; i < 40 && st.queue.length; i++) await tick(2); await tick(); };
const ent = (id: string) => st.entries.find((e) => e.id === id)!;
const live = () => st.entries.filter((e) => e.local_date === DAY && !e.deleted_at);
/** phone == server == summary, queue empty, no sync errors */
function expectInSync() {
  expect(st.queue).toEqual([]);
  for (const e of live()) {
    const r = server.rows.get(e.id);
    expect(r).toBeDefined(); expect(e.sync_error).toBeUndefined();
    expect({ id: e.id, kcal: counted(e) ? e.kcal.best : 0, state: e.needs_review ? 'needs_review' : 'confirmed' }).toEqual({ id: e.id, kcal: r!.kcal, state: r!.state });
    expect(e.server_version).toBe(r!.version);
  }
  expect(dayTotals(live().filter(counted)).kcal).toBe(server.summary());
}
/** the row is visibly flagged with the server's reason; the phone keeps the user's value (never a 0-kcal Review row) */
function expectFlagged(id: string, reason: string, kcal: number) {
  const e = ent(id);
  expect(e).toMatchObject({ sync_error: reason, sync_reason: reason });
  expect(e.needs_review).toBeFalsy(); expect(e.reject_code).toBeUndefined(); expect(e.review_item).toBeUndefined();
  expect(e.kcal.best).toBe(kcal); expect(counted(e)).toBe(true);
  expect(st.queue).toEqual([]); // nothing left behind, no duplicate op
  expect(st.entries.filter((x) => x.id === id)).toHaveLength(1);
  expect(st.entries.filter((x) => x.needs_review && !x.deleted_at)).toHaveLength(0);
}
let r!: ReactTestRenderer;
async function boot(entries: FoodEntry[] = [], queue: unknown[] = []) {
  server.reset(); mockN = 0;
  mockSaved = JSON.stringify({ user: { id: 'u', name: 'A', email: 'a@x', idToken: 't', mock: false }, entries, queue, aiQuota: { used: 0 } });
  await act(async () => { r = create(<StoreProvider><Probe /></StoreProvider>); });
  await tick();
}
beforeAll(() => { (global as unknown as { fetch: unknown }).fetch = jest.fn(fakeFetch); });
afterEach(async () => { await act(async () => { r?.unmount(); }); });

const aiItem = (name: string, kcal: number, protein: number): Item => ({ ...parser.unknown(name), name, matched_text: name, source: 'ai_estimate', data_source: 'ai', ai_estimate: true,
  kcal: { low: kcal, best: kcal, high: kcal }, protein_g: { low: protein, best: protein, high: protein }, carbs_g: 10, fat_g: 5, needs_confirmation: false } as Item);
const aiEntry = (id: string, name: string, kcal: number, protein: number) => entryFromItem(aiItem(name, kcal, protein), { id, slot: 'lunch', raw_text: name, local_date: DAY, tableVersion: DISH_TABLE_VERSION });

describe('G2: a new row (POST) the server refuses follows the PATCH rule', () => {
  test('zorbali shake 120 g protein x3 = 360 g: refused up front with the message, nothing sent; x2 = 240 g saves in sync', async () => {
    await boot();
    await act(async () => { st.addEntries([aiEntry('Z', '1 glass zorbali shake', 300, 120)]); });
    await settle(); expectInSync();
    const n = server.log.length;
    let why: string | null = null;
    await act(async () => { why = st.updateEntry({ ...ent('Z'), qty: 3, kcal: { low: 900, best: 900, high: 900 }, protein_g: { low: 360, best: 360, high: 360 } }); });
    expect(why).toBe(TOO_MUCH_REASON);
    await settle();
    expect(server.log.length).toBe(n); expect(ent('Z').kcal.best).toBe(300);
    await act(async () => { why = st.updateEntry({ ...ent('Z'), qty: 2, kcal: { low: 600, best: 600, high: 600 }, protein_g: { low: 240, best: 240, high: 240 } }); });
    expect(why).toBeNull(); await settle(); expectInSync();
    expect(server.rows.get('Z')).toMatchObject({ kcal: 600, protein: 240 });
  });
  test('Log "Add" of a NEW AI row at 360 g protein (x3 before Add): refused up front, the Add is not sent', async () => {
    await boot();
    let no: { id: string; reason: string }[] = [];
    await act(async () => { no = st.addEntries([aiEntry('Z3', '1 glass zorbali shake', 900, 360)]); });
    expect(no).toEqual([{ id: 'Z3', reason: TOO_MUCH_REASON }]);
    await settle();
    expect(server.log.filter((l) => l.startsWith('POST /v1/entries'))).toEqual([]); expect(live()).toEqual([]);
  });
  test.each([['protein 360', 900, 360], ['protein 310 straight from the AI', 400, 310], ['negative carbs', 300, 10]])('store guard: an AI row with %s is refused', (_n, k, p) => {
    const e = aiEntry('g', 'x', k, p);
    return boot().then(async () => {
      let no: unknown[] = [];
      const row = _n === 'negative carbs' ? { ...e, carbs_g: -1 } : e;
      await act(async () => { no = st.addEntries([row]); });
      expect(no).toHaveLength(1);
    });
  });
  test('a queued NEW AI 6000 row (older build, never synced): POST 400 keeps 6000 with the reason; the queue flows; retry never duplicates', async () => {
    const w = aiEntry('W6', 'wedding plate', 6000, 50);
    const c = { ...aiEntry('C1', 'rajma', 300, 10) };
    await boot([w, c], [{ kind: 'upsert', entry: w, tries: 0 }, { kind: 'upsert', entry: c, tries: 0 }]);
    await settle();
    expectFlagged('W6', 'this item needs kcal (0-5000)', 6000);
    expect(server.rows.get('W6')).toBeUndefined();
    expect(server.rows.get('C1')).toMatchObject({ kcal: 300 }); // the op behind it synced
    await act(async () => { st.retrySync('W6'); }); await settle();
    expectFlagged('W6', 'this item needs kcal (0-5000)', 6000);
    expect(server.log.filter((l) => l === 'POST /v1/entries')).toHaveLength(3); // W6, C1, W6 retry: never re-queued by itself
  });
  test('a queued NEW AI row with protein 360 (older build): POST 400 is flagged with the server reason, never a Review row', async () => {
    const z = aiEntry('Z9', 'zorbali shake', 900, 360);
    await boot([z], [{ kind: 'upsert', entry: z, tries: 0 }]);
    await settle();
    expectFlagged('Z9', 'protein_g, carbs_g and fat_g must be >= 0 (protein <= 300)', 900);
    expect(dayTotals(live().filter(counted)).kcal).toBe(900); // the phone still counts the user's Add (flagged)
  });
  test('a NEW AI row with a 130-character name: the name is cut to the server limit, the row saves in sync', async () => {
    const long = 'homemade '.repeat(14) + 'zorbali'; expect(long.length).toBeGreaterThan(120);
    await boot();
    await act(async () => { st.addEntries([aiEntry('L', long, 400, 20)]); });
    await settle(); expectInSync();
    const sent = server.rows.get('L')!.custom_name;
    expect(bytes(sent)).toBeLessThanOrEqual(120); expect(long.startsWith(sent)).toBe(true); expect(sent.endsWith(' ')).toBe(false);
  });
  test('an old flagged row with a 130-character custom_name: Retry now succeeds (the name is cut when sent)', async () => {
    const long = 'x'.repeat(130);
    const e = { ...aiEntry('O', long, 400, 20), sync_error: 'each item needs dish_id or custom_name', sync_reason: 'each item needs dish_id or custom_name' };
    await boot([e], []);
    await act(async () => { st.retrySync('O'); }); await settle(); expectInSync();
  });
});

describe('any POST 4xx keeps the value (hard gate)', () => {
  test.each([400, 403, 413, 415, 422])('POST %i on a new confirmed row: kept, flagged with the reason, queue flows', async (status) => {
    await boot();
    server.force.push({ status, body: { error: `refused ${status} for a reason` }, when: (it) => it.client_id === 'N' });
    await act(async () => { st.addEntries([aiEntry('N', 'paneer roll', 450, 20), aiEntry('M', 'kulfi', 200, 4)]); });
    await settle();
    expectFlagged('N', `refused ${status} for a reason`, 450);
    expect(server.rows.get('M')).toMatchObject({ kcal: 200 });
  });
  test.each([401, 408, 429, 500])('%i keeps the retry rule (op stays queued with a backoff, row untouched)', async (status) => {
    await boot();
    server.force.push({ status, body: { error: 'later' } });
    await act(async () => { st.addEntries([aiEntry('N', 'paneer roll', 450, 20)]); });
    await tick(20);
    expect(st.queue).toHaveLength(1); expect(st.queue[0].tries).toBe(1); expect(ent('N').sync_error).toBeUndefined(); expect(ent('N').kcal.best).toBe(450);
  });
  test('a typed (custom) POST 400 is flagged the same way, not reopened', async () => {
    await boot();
    server.force.push({ status: 400, body: { error: 'each item needs dish_id or custom_name' } });
    const now = new Date().toISOString();
    const c: FoodEntry = { id: 'T', local_date: DAY, slot: 'lunch', raw_text: 'thali', dish_id: null, custom_name: 'thali', qty: 1, unit: 'count', oil_level: '', kcal: { low: 700, best: 700, high: 700 },
      protein_g: { low: 0, best: 0, high: 0 }, source: 'custom', source_note: 'Your entry', confirmed: true, dish_table_version: DISH_TABLE_VERSION, created_at: now, updated_at: now, deleted_at: null };
    await act(async () => { st.addEntries([c]); }); await settle();
    expectFlagged('T', 'each item needs dish_id or custom_name', 700);
  });
});

const reviewOf = (text: string, id: string) => {
  const it = parseLocal(text).items[0];
  return reviewEntry({ ...it, needs_confirmation: true }, { id, slot: 'lunch', raw_text: text, local_date: DAY, tableVersion: DISH_TABLE_VERSION });
};
describe('G1: "Save · 1 to review later" drafts the server would refuse', () => {
  test.each(['60 roti', '5000 roti', '5001 roti', '5001 g rice', '2 roti'])('"%s": the server has the review row too (phone == server == summary)', async (text) => {
    await boot();
    const e = reviewOf(text, 'D');
    await act(async () => { st.addEntries([e]); }); await settle();
    expectInSync();
    expect(server.rows.get('D')).toMatchObject({ state: 'needs_review', kcal: 0 });
    expect(server.log.filter((l) => l === 'POST /v1/entries')).toHaveLength(1); // decided up front: no 400 round trip
    if (text === '2 roti') expect(server.rows.get('D')!.dish_id).toBe('roti');
    else { expect(e.dish_id).toBeTruthy(); expect(server.rows.get('D')!.dish_id).toBe(''); expect(ent('D').review_item!.dish_id).toBe(e.dish_id); } // by name; the phone keeps the dish reading
  });
  test('"60 roti" later confirmed from Review at 60 pieces: saves 6,600 everywhere', async () => {
    await boot();
    await act(async () => { st.addEntries([reviewOf('60 roti', 'D')]); }); await settle();
    const it = { ...ent('D').review_item!, needs_confirmation: false, unit_options: undefined, flags: [] };
    let why: string | null = 'x';
    await act(async () => { why = st.confirmReview('D', it as Item); }); await settle();
    expect(why).toBeNull(); expectInSync();
    expect(server.rows.get('D')).toMatchObject({ state: 'confirmed', kcal: 6600, dish_id: 'roti' });
  });
  test('draftDishOk mirrors the draft check', () => {
    expect(draftDishOk({ qty: 2, review_item: parseLocal('2 roti').items[0] })).toBe(true);
    expect(draftDishOk({ qty: 60, review_item: parseLocal('60 roti').items[0] })).toBe(false);
    expect(draftDishOk({ qty: 5001 })).toBe(false); expect(draftDishOk({ qty: 0 })).toBe(false);
  });
  test('the server still refuses the dish draft (table drift): the same row is saved by name, never lost', async () => {
    await boot();
    server.force.push({ status: 400, body: { error: 'numbers out of range' }, when: (it) => !!it.dish_id && it.state === 'needs_review' });
    await act(async () => { st.addEntries([reviewOf('2 roti', 'D')]); }); await settle();
    expectInSync();
    expect(server.rows.get('D')).toMatchObject({ state: 'needs_review', dish_id: '', custom_name: 'roti' });
  });
  test('refused even by name: the review row is flagged with the reason on Review (never silent)', async () => {
    await boot();
    server.force.push({ status: 400, body: { error: 'numbers out of range' } }, { status: 400, body: { error: 'still refused' } });
    await act(async () => { st.addEntries([reviewOf('2 roti', 'D')]); }); await settle();
    expect(ent('D')).toMatchObject({ needs_review: true, sync_error: 'still refused', sync_reason: 'still refused' });
    expect(st.queue).toEqual([]);
    let v!: ReactTestRenderer;
    await act(async () => { v = create(<StoreProvider><Probe /><Review /></StoreProvider>); }); await tick();
    const text = v.root.findAll((n) => typeof n.type === 'string').flatMap((n) => [n.props.children].flat()).filter((c) => typeof c === 'string').join(' ');
    expect(text).toContain(SYNC_FAILED_COPY); expect(text).toContain('still refused');
    await act(async () => { v.unmount(); });
  });
});

describe('G3: typed kcal on a failed AI row with a long meal text', () => {
  test('130+ characters: custom_name is cut at a word to <= 120 bytes, raw_text keeps the whole text, it syncs', async () => {
    const text = 'aaj dopahar ko ghar ka bana hua special zorbali shake with dry fruits, kesar, thoda sa shahad and ek scoop vanilla ice cream';
    expect(bytes(text)).toBeGreaterThan(120);
    const f = { ...reviewEntry(parser.unknown(text), { id: 'F', slot: 'dinner', raw_text: text, local_date: DAY, tableVersion: DISH_TABLE_VERSION }), custom_name: text, span: text };
    await boot();
    await act(async () => { st.addEntries([f]); }); await settle(); expectInSync(); // the draft by its (cut) name
    let why: string | null = 'x';
    await act(async () => { why = st.confirmReviewKcal('F', 450); }); await settle();
    expect(why).toBeNull(); expectInSync();
    const e = ent('F');
    expect(e.raw_text).toBe(text); expect(bytes(e.custom_name)).toBeLessThanOrEqual(120); expect(text.startsWith(e.custom_name)).toBe(true);
    expect(server.rows.get('F')).toMatchObject({ kcal: 450, custom_name: e.custom_name, state: 'confirmed' });
  });
  test('serverName: unchanged when short; cut at a word; multi-byte counted as the server does; one long word cut', () => {
    expect(serverName('  dal  ')).toBe('dal');
    const hi = 'आज दोपहर घर का बना हुआ ज़ोरबाली शेक'.repeat(3);
    const h = serverName(hi); expect(bytes(h)).toBeLessThanOrEqual(120); expect(hi.startsWith(h)).toBe(true); expect(h.length).toBeGreaterThan(0);
    const w = serverName('z'.repeat(200)); expect(w).toBe('z'.repeat(120));
    const words = serverName('word '.repeat(40)); expect(bytes(words)).toBeLessThanOrEqual(120); expect(words.endsWith('word')).toBe(true);
  });
});
