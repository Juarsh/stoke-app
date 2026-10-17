// Tester rg7 (Oct 17). H1: a huge table row (5000 plates) is refused up front, like the server (10,000 kcal / 500 g per entry);
// a save the server answers 5xx three times in a row is flagged on its row ("Couldn’t sync this. Tap to retry"), counted only
// as the server has it, and no longer blocks the queue. Import path: a dish the server's newer table has (zarda_pulao) is
// 'Check amount' in Log until the phone pulls (B1), a variant_required on it shows the server's types (B2), the save carries
// the pulled table version (B3), and every response's X-Dish-Table-Version makes an older phone pull (B4/B5). Copy: an empty
// unit never renders "isn’t measured in s.".
import React from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { TextInput } from 'react-native';

jest.mock('../src/lib/config', () => ({ config: { mock: false, apiUrl: 'http://api.test', mockAi: false }, flags: {} }));
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

import { StoreProvider, Store, useStore, applyFlush } from '../src/lib/store';
import { CHECK_AMOUNT_LINE, counted, dayTotals, entryFromItem, entryRefusal, FoodEntry, localDate, TOO_MUCH_REASON, unitReason, UNITS_UNKNOWN } from '../src/lib/domain';
import { parser, DISH_TABLE_VERSION, Item } from '../src/parser';
import { ApiError, headerVersion } from '../src/lib/api';
import { adoptServer, reviewNote } from '../src/lib/serverRow';
import { flush, MAX_FIVES, Op, SERVER_ERROR } from '../src/lib/syncQueue';
import { reviewRowKind } from '../src/lib/confirmBatch';
import { EditSheet } from '../src/components/ItemEditor';
import Review from '../src/app/review';
import Today from '../src/app/(tabs)/index';
import Log from '../src/app/(tabs)/log';

jest.setTimeout(30_000);
const DAY = localDate();
const texts = (t: ReactTestRenderer) => t.root.findAll((n) => typeof n.type === 'string').flatMap((n) => [n.props.children].flat()).filter((c) => typeof c === 'string') as string[];
const textOf = (t: ReactTestRenderer) => texts(t).join('').replace(/\s+/g, ' ');
const tableEntry = (id: string, dish: string, qty: number, unit: string, extra: Partial<FoodEntry> = {}): FoodEntry => {
  const it = { ...parser.recompute(dish, qty, unit, ''), needs_confirmation: false } as Item;
  return { ...entryFromItem(it, { id, slot: 'lunch', raw_text: `${qty} ${unit} ${dish}`, local_date: DAY, tableVersion: DISH_TABLE_VERSION }), qty, unit, ...extra };
};

describe('H1: per-entry ceiling (10,000 kcal / 500 g) on table rows', () => {
  test('store guard and edit sheet refuse it up front with the CEO copy; under the ceiling saves', async () => {
    expect(TOO_MUCH_REASON).toBe('That’s too much for one entry. Try a smaller amount.');
    expect(entryRefusal(tableEntry('a', 'roti', 90, 'count'))).toBeNull(); // 9,900 kcal
    expect(entryRefusal(tableEntry('b', 'roti', 100, 'count'))).toBe(TOO_MUCH_REASON); // 11,000 kcal
    const shake = parser.dishById('protein_shake') ? tableEntry('c', 'protein_shake', 5000, parser.supportedUnits('protein_shake')[0]) : null;
    if (shake) expect(entryRefusal(shake)).toBe(TOO_MUCH_REASON);
    const onSave = jest.fn(); let t!: ReactTestRenderer;
    const it = { ...parser.recompute('roti', 100, 'count', ''), needs_confirmation: false } as Item;
    await act(async () => { t = create(<EditSheet visible it={it} onClose={() => {}} onSave={onSave} onDelete={() => {}} />); });
    expect(t.root.findAll((n) => n.props.testID === 'too-much').length).toBeGreaterThan(0);
    expect(textOf(t)).toContain(TOO_MUCH_REASON);
    await act(async () => { t.root.findAll((n) => n.props.title === 'Save changes')[0].props.onPress(); });
    expect(onSave).not.toHaveBeenCalled();
    await act(async () => { t.unmount(); });
  });
});

describe('H1: 3 consecutive 5xx -> flagged on the row, off the queue head', () => {
  const sender = (fail: Record<string, unknown[]>) => ({
    upsertEntry: jest.fn(async (e: FoodEntry) => { const f = fail[e.id]?.shift(); if (f) throw f; return { version: 1, row: { state: 'confirmed', kcal_best: e.kcal.best, protein_best: e.protein_g.best } }; }),
    deleteEntry: jest.fn(async (id: string) => { const f = fail[id]?.shift(); if (f) throw f; }),
    resolvePending: jest.fn(async () => null), deleteRemembered: jest.fn(async () => {}),
  });
  test('the head op is flagged after the third 5xx in a row; later ops proceed; offline resets the run', async () => {
    const big = tableEntry('BIG', 'roti', 2, 'count'), next = tableEntry('NEXT', 'dal', 1, 'katori');
    const e500 = () => new ApiError(500, '{"error":"save failed"}');
    const s = sender({ BIG: [e500(), new TypeError('Network request failed'), e500(), e500(), e500()] });
    let q: Op[] = [{ kind: 'upsert', entry: big, tries: 0 }, { kind: 'upsert', entry: next, tries: 0 }];
    let now = 1_000_000;
    const runs = [];
    for (let i = 0; i < 5 && q.length; i++) { const r = await flush(q, s, now); runs.push(r); q = r.rest; now += 60 * 60_000; }
    expect(MAX_FIVES).toBe(3);
    // 500, offline (resets), 500, 500, 500 -> flagged on the 5th try, not before
    expect(runs.slice(0, 4).every((r) => r.failed.length === 0 && r.rest[0]?.kind === 'upsert' && (r.rest[0] as { entry: FoodEntry }).entry.id === 'BIG')).toBe(true);
    expect(runs[4].failed).toEqual([{ id: 'BIG', code: SERVER_ERROR, sent: big }]);
    expect(runs[4].rest).toEqual([]); // NEXT went through in the same flush
    expect(s.upsertEntry.mock.calls.map((c) => c[0].id)).toEqual(['BIG', 'BIG', 'BIG', 'BIG', 'BIG', 'NEXT']);
  });
  test('a delete answered 5xx three times goes behind the other ops (nothing to flag on a deleted row)', async () => {
    const e = () => new ApiError(503, 'x'); const s = sender({ D: [e(), e(), e()] });
    const other = tableEntry('O', 'roti', 1, 'count');
    let q: Op[] = [{ kind: 'delete', id: 'D', tries: 0 }, { kind: 'upsert', entry: other, tries: 0 }]; let now = 1;
    for (let i = 0; i < 3; i++) { const r = await flush(q, s, now); q = r.rest; now += 60 * 60_000; }
    expect(s.upsertEntry).toHaveBeenCalledTimes(1);
    expect(q).toHaveLength(1); expect(q[0]).toMatchObject({ kind: 'delete', id: 'D', fives: 0 });
  });
  test('the flagged row counts only as the server has it: nothing for a row it never stored, its last copy for an edit', () => {
    const fresh = tableEntry('N', 'roti', 2, 'count');
    const synced = { ...tableEntry('S', 'dal', 1, 'katori'), server_version: 1 };
    // S was saved before (the server stored it and counts it)
    let p = { entries: [fresh, synced], queue: [] as Op[] };
    p = applyFlush(p, [], { rest: [], resolved: [], rejected: [], versions: { S: 1 }, failed: [], rows: { S: { row: { state: 'confirmed', kcal_best: synced.kcal.best, protein_best: synced.protein_g.best }, sent: synced } } });
    const before = p.entries.find((x) => x.id === 'S')!.server_counts;
    expect(before).toEqual({ kcal: synced.kcal.best, protein: synced.protein_g.best });
    // the user makes S huge-ish (still allowed) and the server 500s three times; N's first save 500s three times too
    const s2 = { ...p.entries.find((x) => x.id === 'S')!, qty: 3, kcal: { low: 900, best: 900, high: 900 } };
    p = { ...p, entries: p.entries.map((x) => (x.id === 'S' ? s2 : x)) };
    p = applyFlush(p, [], { rest: [], resolved: [], rejected: [], versions: {}, failed: [{ id: 'N', code: SERVER_ERROR, sent: fresh }, { id: 'S', code: SERVER_ERROR, sent: s2 }] });
    const n = p.entries.find((x) => x.id === 'N')!, s = p.entries.find((x) => x.id === 'S')!;
    expect(n).toMatchObject({ sync_error: SERVER_ERROR, server_failed: true }); expect(n.sync_reason).toBeUndefined();
    expect(s).toMatchObject({ sync_error: SERVER_ERROR, server_failed: true });
    expect(dayTotals(p.entries).kcal).toBe(Math.round(synced.kcal.best)); // N: 0 (server never had it); S: the server's copy
    // retry succeeds: counted as saved again
    p = applyFlush(p, [], { rest: [], resolved: [], rejected: [], versions: { N: 1 }, failed: [], rows: { N: { row: { state: 'confirmed', kcal_best: fresh.kcal.best, protein_best: fresh.protein_g.best }, sent: fresh } } });
    expect(p.entries.find((x) => x.id === 'N')!.server_failed).toBeUndefined();
    expect(dayTotals(p.entries).kcal).toBe(Math.round(synced.kcal.best + fresh.kcal.best));
  });
});

// ---- a fake server with a NEWER dish table (zarda_pulao imported at version V+1, in the pulao variant group) ----
const NEW_V = DISH_TABLE_VERSION + 1;
const ZARDA = { kcal: 390, protein: 5 };
const zardaOpts = [{ dish_id: 'veg_pulao', name: 'veg pulao', kcal: 300, protein_g: 6 }, { dish_id: 'zarda_pulao', name: 'zarda pulao', kcal: ZARDA.kcal, protein_g: ZARDA.protein }];
const server = {
  version: DISH_TABLE_VERSION, dishes: [] as { id: string; name: string; version: number; supported_units: string[] }[],
  rows: new Map<string, { kcal: number; state: string; dish_id: string; unit: string; version: number }>(),
  log: [] as { method: string; path: string; body: Record<string, unknown> }[],
  parse: null as unknown,
  reset() { this.version = DISH_TABLE_VERSION; this.dishes = []; this.rows.clear(); this.log = []; this.parse = null; },
  importZarda() { this.version = NEW_V; this.dishes = [{ id: 'zarda_pulao', name: 'zarda pulao', version: NEW_V, supported_units: ['katori', 'plate', 'gram'] }]; },
};
const reply = (status: number, body: unknown = {}) => ({ ok: status < 300, status, headers: { get: (k: string) => (k.toLowerCase() === 'x-dish-table-version' ? String(server.version) : null) },
  json: async () => body, text: async () => JSON.stringify(body) });
async function fakeFetch(url: string, init: { method: string; body?: string }) {
  const path = url.replace('http://api.test', ''); const b = init.body ? JSON.parse(init.body) : {};
  server.log.push({ method: init.method, path, body: b });
  if (path === '/v1/remembered') return reply(200, { remembered: [] });
  if (path === '/v1/dishes') return reply(200, server.dishes);
  if (path === '/v1/parse') return reply(200, server.parse);
  if (init.method === 'POST' && path === '/v1/entries') {
    const it = b.items[0];
    if (server.rows.has(it.client_id)) { const r = server.rows.get(it.client_id)!; return reply(200, { entries: [{ version: r.version, state: r.state, kcal_best: r.kcal }], duplicates: [it.client_id] }); }
    if (it.dish_id === 'zarda_pulao' && it.state !== 'needs_review') {
      if (server.version < NEW_V) return reply(400, { error: 'item 0: unknown dish_id' });
      if (it.variant_dish_id !== 'zarda_pulao') return reply(422, { error: { code: 'variant_required', item: 0, dish_id: 'zarda_pulao', message: 'Pick which one this was.', variant_options: zardaOpts } });
    }
    const kcal = it.state === 'needs_review' ? 0 : it.dish_id === 'zarda_pulao' ? ZARDA.kcal * (it.qty ?? 1) : Number(it.kcal ?? 0);
    const r = { kcal, state: it.state === 'needs_review' ? 'needs_review' : 'confirmed', dish_id: it.dish_id, unit: it.unit, version: 1 };
    server.rows.set(it.client_id, r);
    return reply(201, { entries: [{ version: 1, state: r.state, dish_id: r.dish_id, unit: r.unit, qty: it.qty, kcal_best: r.kcal, protein_best: 0 }] });
  }
  const m = /^\/v1\/entries\/(.+)$/.exec(path); const r = m && server.rows.get(decodeURIComponent(m[1]));
  if (!r) return reply(404, { error: 'entry not found' });
  if (init.method === 'DELETE') { server.rows.delete(decodeURIComponent(m![1])); return reply(204); }
  if (b.dish_id === 'zarda_pulao' && b.variant_dish_id !== 'zarda_pulao') return reply(422, { error: { code: 'variant_required', message: 'Pick which one this was.', variant_options: zardaOpts } });
  Object.assign(r, { state: b.state ?? 'confirmed', kcal: b.dish_id === 'zarda_pulao' ? ZARDA.kcal : Number(b.kcal ?? r.kcal), dish_id: b.dish_id ?? r.dish_id, version: r.version + 1 });
  return reply(200, { version: r.version, state: r.state, dish_id: r.dish_id, kcal_best: r.kcal, protein_best: 0 });
}
let st!: Store;
function Probe() { st = useStore(); return null; }
const tick = async (n = 12) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((res) => setTimeout(res, 0)); }); };
const settle = async () => { for (let i = 0; i < 40 && st.queue.length; i++) await tick(2); await tick(); };
const ent = (id: string) => st.entries.find((e) => e.id === id)!;
let r!: ReactTestRenderer;
async function boot(ui?: React.ReactNode, entries: FoodEntry[] = []) {
  mockN = 0;
  mockSaved = JSON.stringify({ user: { id: 'u', name: 'A', email: 'a@x', idToken: 't', mock: false }, entries, queue: [], aiQuota: { used: 0 } });
  await act(async () => { r = create(<StoreProvider><Probe />{ui}</StoreProvider>); });
  await tick();
}
const zardaItem = (): Item => ({ dish_id: 'zarda_pulao', name: 'zarda pulao', matched_text: '1 plate zarda', quantity: 1, unit: 'plate', grams: 200, oil_level: '',
  kcal: { low: 320, best: ZARDA.kcal, high: 470 }, protein_g: { low: 4, best: ZARDA.protein, high: 6.5 }, carbs_g: 72, fat_g: 9, source: 'table', data_source: '', source_note: '',
  fuzzy: false, needs_confirmation: true, default_portion: false, span_start: 0, span_end: 13, ai_estimate: false } as Item);
beforeAll(() => { (global as unknown as { fetch: unknown }).fetch = jest.fn(fakeFetch); });
beforeEach(() => { server.reset(); parser.setPulledUnits(null); });
afterEach(async () => { await act(async () => { r?.unmount(); }); parser.setPulledUnits(null); });

describe('Import path (zarda_pulao at a newer server table)', () => {
  test('headerVersion reads X-Dish-Table-Version', () => {
    expect(headerVersion({ headers: { get: () => '7' } })).toBe(7);
    expect(headerVersion({ headers: { get: () => null } })).toBe(0);
    expect(headerVersion({})).toBe(0);
  });
  test('B1: Log shows the server-matched dish as "Check amount" (held, not counted), never "Couldn’t estimate this"; after the pull it is an ordinary row', async () => {
    server.parse = { items: [zardaItem()], unmatched: [], used_ai: false, fallback: 'none', ai_state: 'none', custom_items: [] };
    await boot(<Log />);
    const input = r.root.findAll((n) => n.type === TextInput && n.props.accessibilityLabel === 'What did you eat?')[0];
    await act(async () => { input.props.onChangeText('1 plate zarda'); });
    await act(async () => { await new Promise((res) => setTimeout(res, 800)); }); await tick();
    expect(server.log.some((l) => l.path === '/v1/parse')).toBe(true);
    expect(textOf(r)).not.toContain('Couldn’t estimate this');
    expect(r.root.findAll((n) => n.props.testID === 'held-row' && typeof n.type !== 'string')).toHaveLength(1);
    expect(textOf(r)).toContain(UNITS_UNKNOWN);
    expect(textOf(r)).toContain('not counted');
    // the server's table is newer: the units come down; the row becomes an ordinary one
    server.importZarda();
    await act(async () => { await st.api.getDishUnits().then((t) => { if (t) parser.setPulledUnits(t.units, t.version, t.names); }); });
    await act(async () => { input.props.onChangeText('1 plate zarda '); });
    await act(async () => { await new Promise((res) => setTimeout(res, 800)); }); await tick();
    expect(r.root.findAll((n) => n.props.testID === 'held-row' && typeof n.type !== 'string')).toHaveLength(0);
    expect(textOf(r)).toContain('Zarda pulao');
  });
  test('B4/B3/B2: a response with a newer X-Dish-Table-Version makes the phone pull; the new dish is saved with that version; variant_required shows the server’s types and a pick saves', async () => {
    await boot(<Review />);
    expect(st.dishUnits ?? null).toBeNull(); // the server has nothing newer
    server.importZarda();
    await act(async () => { st.addEntries([tableEntry('R', 'roti', 1, 'count')]); }); await settle(); await tick();
    expect(server.log.filter((l) => l.path === '/v1/dishes').length).toBeGreaterThanOrEqual(2); // pulled on the newer header
    expect(st.dishUnits).toMatchObject({ version: NEW_V, units: { zarda_pulao: ['katori', 'plate', 'gram'] } });
    expect(parser.pulledVersion).toBe(NEW_V);
    const z = { ...entryFromItem({ ...zardaItem(), needs_confirmation: false }, { id: 'Z', slot: 'lunch', raw_text: '1 plate zarda', local_date: DAY, tableVersion: DISH_TABLE_VERSION }) };
    expect(entryRefusal(z)).toBeNull();
    await act(async () => { st.addEntries([z]); }); await settle();
    const post = server.log.filter((l) => l.method === 'POST' && l.path === '/v1/entries').find((l) => (l.body.items as { client_id: string }[])[0].client_id === 'Z')!;
    expect((post.body.items as { dish_table_version: number }[])[0].dish_table_version).toBe(NEW_V); // never the stale bundled version
    // 422 variant_required: back in Review with the server's types and the pick line (never a dead end)
    expect(ent('Z')).toMatchObject({ needs_review: true, reject_code: 'variant_required' });
    expect(ent('Z').server_note).toBeUndefined();
    expect(reviewRowKind(ent('Z').review_item!)).toBe('chips');
    expect(textOf(r)).toContain('Pick a type to save this.');
    expect(textOf(r)).toContain('Zarda · 390 kcal'); expect(textOf(r)).toContain('Veg · 300 kcal'); expect(textOf(r)).not.toContain('zarda_pulao');
    const pick = r.root.findAll((n) => typeof n.props.onPress === 'function' && /^Zarda pulao, 390 calories$/.test(String(n.props.accessibilityLabel ?? '')));
    expect(pick.length).toBeGreaterThan(0);
    await act(async () => { pick[0].props.onPress(); }); await settle();
    expect(ent('Z')).toMatchObject({ dish_id: 'zarda_pulao' }); expect(ent('Z').needs_review).toBeFalsy(); expect(ent('Z').reject_code).toBeUndefined();
    expect(counted(ent('Z'))).toBe(true);
    expect(server.rows.get('Z')).toMatchObject({ state: 'confirmed', kcal: ZARDA.kcal });
    expect(ent('Z').kcal.best).toBe(ZARDA.kcal);
  });
  test('B4: an older-table phone saving dal in plates (the server no longer has plate) gets the unit note', () => {
    parser.setPulledUnits({ dal: ['katori', 'spoon', 'plate', 'gram'] }, DISH_TABLE_VERSION); // what the phone (still) thinks
    const e = tableEntry('D', 'dal', 1, 'plate');
    const a = adoptServer(e, { state: 'needs_review', dish_id: 'dal', qty: 1, unit: 'katori', kcal_best: 180 });
    expect(a.server_note).toBe('Not counted yet: dal isn’t measured in plates. Check the amount and add it again.');
    expect(counted(a)).toBe(false);
  });
});

describe('H1: the flagged row on Today', () => {
  test('"Couldn’t sync this. Tap to retry", not counted; tapping retries and a good save counts it', async () => {
    const n = { ...tableEntry('N', 'roti', 2, 'count'), sync_error: SERVER_ERROR, server_failed: true };
    await boot(<Today />, [n]);
    expect(textOf(r)).toContain('Couldn’t sync this. Tap to retry');
    expect(textOf(r)).not.toContain('save failed');
    expect(textOf(r)).toContain('— kcal · not counted');
    expect(dayTotals(st.entries).kcal).toBe(0);
    const row = r.root.findAll((x) => typeof x.props.onPress === 'function' && /couldn’t sync this/i.test(String(x.props.accessibilityLabel ?? '')));
    expect(row.length).toBeGreaterThan(0);
    await act(async () => { row[0].props.onPress(); }); await settle();
    expect(server.rows.get('N')).toMatchObject({ state: 'confirmed' });
    expect(ent('N').sync_error).toBeUndefined(); expect(ent('N').server_failed).toBeUndefined();
    expect(dayTotals(st.entries).kcal).toBe(Math.round(n.kcal.best));
  });
});

describe('Copy: an empty unit never renders "isn’t measured in s."', () => {
  test('edit-sheet line and review note fall back to the generic line', () => {
    expect(CHECK_AMOUNT_LINE).toBe('Check the amount and add it again.');
    expect(unitReason('', 'dal')).toBe('Check the amount and add it again.');
    expect(unitReason('  ', 'dal')).toBe('Check the amount and add it again.');
    const e = { ...tableEntry('E', 'dal', 1, 'katori'), unit: '' };
    expect(reviewNote(e)).toBe('Not counted yet: Check the amount and add it again.');
    expect(reviewNote(e, { unit: 'katori' })).not.toMatch(/measured in s\b/);
    expect(unitReason('plate', 'dal')).toBe('Dal isn’t measured in plates. Pick another unit.');
  });
});
