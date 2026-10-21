// Tester rg6 (Oct 17) F1 / F5 / F4. F1: the edit sheet offered all 7 unit chips and the server silently stored a unit the
// dish doesn't come in as needs_review while the phone counted it. Now (a) the sheet offers only the dish's units (the
// server's own list: unitParity.test.ts), the store guard refuses any other unit with a readable reason; (b) whatever the
// server answers a save with is what the phone shows and counts: a needs_review row goes to Review (not counted, with the
// reason), other numbers / amounts are taken with a note. F5: qty 0 -> the server's readable 400, flagged on the row.
// F4 (PE): a variant_required edit shows exactly "Pick a type to save this."; tapping it opens the types; a pick re-saves.
// Runs the REAL store against a fake server following internal/food/food.go @ this change (UnitSupported, QtyReason).
import { unitChips } from '../src/lib/labels';
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

import { StoreProvider, Store, useStore, applyFlush } from '../src/lib/store';
import { counted, dayTotals, entryFromItem, entryRefusal, FoodEntry, dayOf, localDate, unitReason, UNITS_UNKNOWN } from '../src/lib/domain';
import { parser, DISH_TABLE_VERSION, Item, UNITS } from '../src/parser';
import { ApiError } from '../src/lib/api';
import { adoptServer } from '../src/lib/serverRow';
import { EditSheet } from '../src/components/ItemEditor';
import Review from '../src/app/review';
import Today from '../src/features/today/TodayScreen';

jest.setTimeout(30_000);
const DAY = dayOf();
const QTY = 'Enter an amount above 0.';

// ---- fake server (food.go): table rows recomputed; a unit the dish doesn't come in -> draft needs_review (counts 0);
// qty <= 0 -> 400 "item 0: Enter an amount above 0."; a forced reply when scripted ----
type Row = { client_id: string; version: number; kcal: number; protein: number; state: string; dish_id: string; qty: number; unit: string; deleted: boolean };
const server = {
  rows: new Map<string, Row>(), log: [] as { method: string; path: string; body: Record<string, unknown> }[], force: [] as { status: number; body: unknown }[],
  /** GET /v1/dishes rows (id, version, supported_units) */
  dishes: [] as { id: string; version: number; supported_units: string[] }[],
  reset() { this.rows.clear(); this.log = []; this.force = []; this.dishes = []; },
  summary() { return [...this.rows.values()].filter((r) => !r.deleted && r.state !== 'needs_review').reduce((s, r) => s + r.kcal, 0); },
};
const reply = (status: number, body: unknown = {}) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const view = (r: Row) => ({ client_id: r.client_id, id: 1, version: r.version, state: r.state, dish_id: r.dish_id, qty: r.qty, unit: r.unit, kcal_best: r.kcal, kcal_low: r.kcal, kcal_high: r.kcal, protein_best: r.protein, protein_low: r.protein, protein_high: r.protein, carbs_g: 0, fat_g: 0 });
function save(it: { dish_id: string; qty?: number; unit?: string; state?: string }, prefix: string): Omit<Row, 'client_id' | 'version' | 'deleted'> | { status: number; msg: string } {
  if (it.qty !== undefined && it.qty <= 0) return { status: 400, msg: `${prefix}${QTY}` };
  const qty = it.qty ?? 1; const d = parser.dishById(it.dish_id)!;
  if (it.state === 'needs_review' || !parser.unitRule(it.dish_id, it.unit ?? '')) { // the server's own rule
    const r = parser.recompute(it.dish_id, qty, d.unit, ''); // draft: the dish's own unit numbers, not counted
    return { kcal: r.kcal.best, protein: r.protein_g.best, state: 'needs_review', dish_id: it.dish_id, qty, unit: d.unit };
  }
  const r = parser.recompute(it.dish_id, qty, it.unit!, '');
  return { kcal: r.kcal.best, protein: r.protein_g.best, state: 'confirmed', dish_id: it.dish_id, qty, unit: it.unit! };
}
async function fakeFetch(url: string, init: { method: string; body?: string }) {
  const path = url.replace('http://api.test', ''); const b = init.body ? JSON.parse(init.body) : {};
  server.log.push({ method: init.method, path, body: b });
  if (path === '/v1/remembered') return reply(200, { remembered: [] });
  if (path === '/v1/dishes') return reply(200, server.dishes);
  const dup = init.method === 'POST' && server.rows.has(b.items?.[0]?.client_id);
  if (server.force.length && /^\/v1\/entries/.test(path) && !dup) { const x = server.force.shift()!; return reply(x.status, x.body); }
  if (init.method === 'POST' && path === '/v1/entries') {
    const it = b.items[0]; const ex = server.rows.get(it.client_id);
    if (ex && !ex.deleted) return reply(200, { entries: [view(ex)], duplicates: [it.client_id] }); // the app PATCHes then
    const res = save(it, 'item 0: ');
    if ('status' in res) return reply(res.status, { error: res.msg });
    const r: Row = { client_id: it.client_id, version: 1, deleted: false, ...res };
    server.rows.set(r.client_id, r); return reply(201, { entries: [view(r)] });
  }
  const m = /^\/v1\/entries\/(.+)$/.exec(path); const r = m && server.rows.get(decodeURIComponent(m[1]));
  if (!r || r.deleted) return reply(404, { error: 'entry not found' });
  if (init.method === 'DELETE') { r.deleted = true; return reply(204); }
  const res = save({ dish_id: b.dish_id ?? r.dish_id, qty: b.qty ?? r.qty, unit: b.unit ?? r.unit, state: b.state }, '');
  if ('status' in res) return reply(res.status, { error: res.msg });
  Object.assign(r, res, { version: r.version + 1 });
  return reply(200, view(r));
}

let st!: Store;
function Probe() { st = useStore(); return null; }
const tick = async (n = 12) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((res) => setTimeout(res, 0)); }); };
const settle = async () => { for (let i = 0; i < 40 && st.queue.length; i++) await tick(2); await tick(); };
const ent = (id: string) => st.entries.find((e) => e.id === id)!;
const live = () => st.entries.filter((e) => e.local_date === DAY && !e.deleted_at);
/** phone == server == summary: each row counted on the phone exactly when (and as much as) the server counts it */
function expectInSync() {
  expect(st.queue).toEqual([]);
  for (const e of live()) {
    const r = server.rows.get(e.id);
    if (!r) { expect(counted(e) && !e.sync_error ? e.kcal.best : 0).toBe(0); continue; }
    expect({ id: e.id, kcal: counted(e) ? e.kcal.best : 0, review: !!e.needs_review }).toEqual({ id: e.id, kcal: r.state === 'needs_review' ? 0 : r.kcal, review: r.state === 'needs_review' });
    if (counted(e)) expect({ qty: e.qty, unit: e.unit }).toEqual({ qty: r.qty, unit: r.unit });
  }
  expect(dayTotals(live().filter((e) => counted(e) && server.rows.has(e.id))).kcal).toBe(server.summary());
}
let r!: ReactTestRenderer;
async function boot(entries: FoodEntry[] = [], queue: unknown[] = [], ui?: React.ReactNode) {
  server.reset(); mockN = 0;
  mockSaved = JSON.stringify({ user: { id: 'u', name: 'A', email: 'a@x', idToken: 't', mock: false }, entries, queue, aiQuota: { used: 0 } });
  await act(async () => { r = create(<StoreProvider><Probe />{ui}</StoreProvider>); });
  await tick();
}
beforeAll(() => { (global as unknown as { fetch: unknown }).fetch = jest.fn(fakeFetch); });
afterEach(async () => { await act(async () => { r?.unmount(); }); });

const tableEntry = (id: string, dish: string, qty: number, unit: string, extra: Partial<FoodEntry> = {}): FoodEntry => {
  // the numbers the phone computes (what an older build counted for any unit)
  const it = { ...parser.recompute(dish, qty, unit, ''), needs_confirmation: false } as Item;
  return { ...entryFromItem(it, { id, slot: 'lunch', raw_text: `${qty} ${unit} ${dish}`, local_date: DAY, tableVersion: DISH_TABLE_VERSION }), qty, unit, ...extra };
};
const texts = (t: ReactTestRenderer) => t.root.findAll((n) => typeof n.type === 'string').flatMap((n) => [n.props.children].flat()).filter((c) => typeof c === 'string') as string[];
const textOf = (t: ReactTestRenderer) => texts(t).join('').replace(/\s+/g, ' ');

describe('F1 (a): only the units the dish comes in', () => {
  test('edit sheet: dal offers the server list (katori, spoon, plate, gram), never piece; roti never katori', async () => {
    for (const dish of ['dal', 'roti']) {
      let t!: ReactTestRenderer;
      const it = { ...parser.recompute(dish, 1, parser.dishById(dish)!.unit, ''), needs_confirmation: false } as Item;
      await act(async () => { t = create(<EditSheet visible it={it} onClose={() => {}} onSave={() => {}} onDelete={() => {}} />); });
      const chips = t.root.find((n) => n.props.testID === 'unit-chips' && typeof n.type !== 'string');
      const labels = chips.findAll((n) => typeof n.props.label === 'string' && typeof n.props.onPress === 'function').map((n) => n.props.label);
      expect(labels).toEqual(unitChips(parser.supportedUnits(dish), it.unit).map((c) => c.label)); expect(labels).not.toContain('count'); // count shares the piece chip
      expect(labels.length).toBeLessThan(UNITS.length);
      await act(async () => { t.unmount(); });
    }
    expect(parser.supportedUnits('dal')).toEqual(['katori', 'spoon', 'plate', 'gram']);
    expect(parser.supportedUnits('roti')).not.toContain('katori');
  });
  test('a reading in a unit the dish isn’t measured in (1 piece dal): the sheet says so and Save is off until a unit is picked', async () => {
    const onSave = jest.fn(); let t!: ReactTestRenderer;
    const it = { ...parser.recompute('dal', 1, 'piece', ''), unit: 'piece', needs_confirmation: false } as Item;
    await act(async () => { t = create(<EditSheet visible it={it} onClose={() => {}} onSave={onSave} onDelete={() => {}} />); });
    expect(textOf(t)).toContain('Dal isn’t measured in pieces. Pick another unit.');
    const save = t.root.findAll((n) => n.props.title === 'Save changes')[0];
    await act(async () => { save.props.onPress(); }); expect(onSave).not.toHaveBeenCalled();
    const katori = t.root.findAll((n) => n.props.label === 'katori' && typeof n.props.onPress === 'function')[0];
    await act(async () => { katori.props.onPress(); });
    expect(textOf(t)).not.toContain('isn’t measured');
    await act(async () => { t.root.findAll((n) => n.props.title === 'Save changes')[0].props.onPress(); });
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ unit: 'katori', dish_id: 'dal' }));
    await act(async () => { t.unmount(); });
  });
  test('store guard: a table row in an unsupported unit (or litre) is refused with the reason, nothing sent', async () => {
    expect(entryRefusal(tableEntry('x', 'dal', 1, 'piece'))).toBe('Dal isn’t measured in pieces. Pick another unit.');
    expect(entryRefusal({ ...tableEntry('x', 'dal', 1, 'katori'), unit: 'litre' })).toBe('Dal isn’t measured in litres. Pick another unit.');
    expect(entryRefusal(tableEntry('x', 'dal', 2, 'katori'))).toBeNull();
    await boot();
    let refused: unknown;
    await act(async () => { refused = st.addEntries([tableEntry('P', 'dal', 1, 'piece')]); });
    expect(refused).toEqual([{ id: 'P', reason: unitReason('piece', 'dal') }]);
    await settle(); expect(server.log.filter((l) => l.path.startsWith('/v1/entries'))).toHaveLength(0);
    await act(async () => { st.addEntries([tableEntry('K', 'dal', 2, 'katori')]); }); await settle();
    let why: string | null = null;
    await act(async () => { why = st.updateEntry({ ...ent('K'), unit: 'glass' }); });
    expect(why).toBe('Dal isn’t measured in glasses. Pick another unit.'); await settle();
    expect(ent('K')).toMatchObject({ unit: 'katori', qty: 2 }); expectInSync();
  });
});

describe('F1 (b): the phone shows (and counts) what the server saved', () => {
  test('an old queued save in piece (sent before this build): the server keeps it for review -> Review row with the reason, never counted', async () => {
    const e = tableEntry('OLD', 'dal', 1, 'piece');
    expect(counted(e)).toBe(true); expect(e.kcal.best).toBeGreaterThan(0); // what the phone used to count
    await boot([e, tableEntry('OK', 'dal', 2, 'katori')], [{ kind: 'upsert', entry: e, tries: 0 }, { kind: 'upsert', entry: tableEntry('OK', 'dal', 2, 'katori'), tries: 0 }],
      <><Today /><Review /></>);
    await settle();
    expect(server.rows.get('OLD')).toMatchObject({ state: 'needs_review' });
    const x = ent('OLD');
    expect(x).toMatchObject({ needs_review: true, confirmed: false, reject_code: 'server_review', server_note: 'Not counted yet: dal isn’t measured in pieces. Check the amount and add it again.' });
    expect(counted(x)).toBe(false); expect(x.review_item).toMatchObject({ dish_id: 'dal', unit: 'katori' });
    expectInSync();
    expect(dayTotals(live().filter(counted)).kcal).toBe(300); // only the 2 katori dal
    const ring = r.root.findAll((n) => typeof n.props.eaten === 'number' && 'kcalLeft' in n.props)[0];
    expect(ring.props.eaten).toBe(300);
    expect(textOf(r)).toContain('Not counted yet: dal isn’t measured in pieces.');
    expect(r.root.findAll((n) => n.props.testID === 'server-note').length).toBeGreaterThanOrEqual(2); // Today + Review
    // checking it in Review (the server's unit) counts it, in sync
    let why: string | null = null;
    await act(async () => { why = st.confirmReview('OLD', { ...x.review_item!, needs_confirmation: false }); });
    expect(why).toBeNull(); await settle();
    expect(ent('OLD')).toMatchObject({ unit: 'katori' }); expect(ent('OLD').needs_review).toBeFalsy(); expect(ent('OLD').server_note).toBeUndefined();
    expect(server.rows.get('OLD')).toMatchObject({ state: 'confirmed', unit: 'katori' }); expectInSync();
  });
  test('litre (old queue) -> the server keeps it for review; the phone doesn’t count 220', async () => {
    const e = { ...tableEntry('L', 'dal', 1, 'katori'), unit: 'litre' };
    await boot([e], [{ kind: 'upsert', entry: e, tries: 0 }]); await settle();
    expect(ent('L')).toMatchObject({ needs_review: true }); expect(counted(ent('L'))).toBe(false); expectInSync();
  });
  test('the server saved other numbers / another amount: the row takes them, says so, and counts what the server counts', async () => {
    const e = tableEntry('C', 'dal', 2, 'katori');
    await boot([], [], <Today />);
    server.force.push({ status: 201, body: { entries: [{ client_id: 'C', version: 1, state: 'corrected', dish_id: 'dal', qty: 1, unit: 'katori', kcal_best: 150, kcal_low: 112, kcal_high: 188, protein_best: 7, protein_low: 5, protein_high: 9 }] } });
    await act(async () => { st.addEntries([e]); }); await settle();
    expect(ent('C')).toMatchObject({ qty: 1, unit: 'katori', kcal: { best: 150 }, server_note: 'Saved as 1 katori · 150 kcal.' });
    expect(counted(ent('C'))).toBe(true);
    expect(textOf(r)).toContain('Saved as 1 katori · 150 kcal.');
    await act(async () => { st.clearServerNote('C'); });
    expect(ent('C').server_note).toBeUndefined(); expect(ent('C').kcal.best).toBe(150);
  });
  test('applyFlush: a row the user changed while it was being sent is never overwritten by the server copy', () => {
    const sent = tableEntry('A', 'dal', 1, 'piece');
    const changed = { ...sent, unit: 'katori', updated_at: 'later' };
    const op = { kind: 'upsert' as const, entry: sent, tries: 0 };
    const row = { version: 1, state: 'needs_review', dish_id: 'dal', qty: 1, unit: 'katori', kcal_best: 150 };
    const base = { rest: [], resolved: [], rejected: [], versions: { A: 1 }, failed: [], gone: [], rows: { A: { row, sent } } };
    expect(applyFlush({ entries: [sent], queue: [op] }, [op], base).entries[0]).toMatchObject({ needs_review: true, server_note: expect.any(String) });
    const kept = applyFlush({ entries: [changed], queue: [op] }, [op], base).entries[0];
    expect(kept).toMatchObject({ unit: 'katori' }); expect(kept.needs_review).toBeFalsy(); expect(kept.server_note).toBeUndefined();
    // same numbers back: unchanged
    const B = tableEntry('B', 'dal', 2, 'katori'); // one instance (its timestamps)
    const sameRow = { version: 1, state: 'confirmed', dish_id: 'dal', qty: 2, unit: 'katori', kcal_best: 300, protein_best: B.protein_g.best };
    expect(adoptServer(B, sameRow)).toBe(B);
  });
});

describe('F5: qty 0', () => {
  test('the server refuses qty 0 with a readable reason (no "item 0:"); the row is flagged with it and counts nothing', async () => {
    const e = { ...tableEntry('Z', 'dal', 1, 'katori'), qty: 0, kcal: { low: 0, best: 0, high: 0 } };
    await boot([e], [{ kind: 'upsert', entry: e, tries: 0 }]); await settle();
    expect(ent('Z').sync_error).toBeTruthy(); expect(ent('Z').sync_reason).toBe(QTY);
    expect(server.rows.has('Z')).toBe(false); expect(dayTotals(live().filter(counted)).kcal).toBe(0); expectInSync();
    expect(new ApiError(400, JSON.stringify({ error: 'item 3: Enter an amount above 0.' })).reason).toBe(QTY);
    expect(entryRefusal(e)).not.toBeNull(); // and the phone never queues one itself
  });
});

describe('F4 (PE): variant_required on an edit', () => {
  test('the row shows exactly "Pick a type to save this."; tapping opens the types; a pick re-saves as that type', async () => {
    const e = { ...tableEntry('V', 'veg_biryani', 1, 'plate'), variant_dish_id: 'veg_biryani' };
    await boot([e], [{ kind: 'upsert', entry: e, tries: 0 }], <Today />); await settle(); expectInSync();
    const opts = parser.variantGroup('veg_biryani', 1, 'plate')!;
    server.force.push({ status: 422, body: { error: { code: 'variant_required', message: 'dish_id veg_biryani is a variant group; send variant_dish_id', dish_id: 'veg_biryani', variant_options: opts } } });
    await act(async () => { st.updateEntry({ ...ent('V'), qty: 2, kcal: { low: 800, best: 800, high: 800 } }); }); await settle();
    expect(ent('V')).toMatchObject({ sync_error: 'variant_required', sync_reason: 'Pick a type to save this.' });
    const row = r.root.find((n) => n.props.accessibilityRole === 'button' && typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityLabel.startsWith('Lunch ·') && n.props.accessibilityLabel.endsWith(': Pick a type to save this.') && typeof n.props.onPress === 'function');
    expect(textOf(r)).toContain('Pick a type to save this.');
    expect(textOf(r)).not.toContain('variant group'); expect(textOf(r)).not.toContain('Couldn’t sync this');
    await act(async () => { row.props.onPress(); });
    const chip = r.root.findAll((n) => n.props.a11y === `Save as chicken biryani, ${opts[1].kcal} calories` && typeof n.props.onPress === 'function')[0];
    expect(chip).toBeDefined();
    await act(async () => { chip.props.onPress(); }); await settle();
    const last = server.log.filter((l) => l.method === 'PATCH').pop()!;
    expect(last.body).toMatchObject({ dish_id: 'chicken_biryani', variant_dish_id: 'chicken_biryani', qty: 2 });
    expect(ent('V')).toMatchObject({ dish_id: 'chicken_biryani', qty: 2 }); expect(ent('V').sync_error).toBeUndefined();
    expect(server.rows.get('V')).toMatchObject({ dish_id: 'chicken_biryani', state: 'confirmed' });
    expectInSync();
    expect(r.root.findAll((n) => n.props.testID === 'variant-pick')).toHaveLength(0);
  });
});

describe('PE: units come down with the dish table; a dish with none on the phone is "Check amount", not counted', () => {
  // dal as if the phone's table had no units for it (no pulled data, no supported_units, no seed)
  let saved: string[] | undefined;
  const dal = () => parser.dishById('dal') as unknown as { supported_units?: string[] };
  beforeEach(() => { saved = dal().supported_units; delete dal().supported_units; parser.setSeedUnits({}); parser.setPulledUnits(null); });
  afterEach(() => { dal().supported_units = saved; parser.setSeedUnits(require('../src/data/supported-units.json')); parser.setPulledUnits(null); });

  test('sheet: no unit chips at all (never the 7), "Check amount", Save off', async () => {
    const onSave = jest.fn(); let t!: ReactTestRenderer;
    const it = { ...parser.recompute('dal', 1, 'katori', ''), needs_confirmation: false } as Item;
    await act(async () => { t = create(<EditSheet visible it={it} onClose={() => {}} onSave={onSave} onDelete={() => {}} />); });
    const chips = t.root.find((n) => n.props.testID === 'unit-chips' && typeof n.type !== 'string');
    expect(chips.findAll((n) => typeof n.props.label === 'string' && typeof n.props.onPress === 'function')).toHaveLength(0);
    expect(textOf(t)).toContain(UNITS_UNKNOWN); expect(UNITS_UNKNOWN).toBe('Check amount');
    await act(async () => { t.root.findAll((n) => n.props.title === 'Save changes')[0].props.onPress(); });
    expect(onSave).not.toHaveBeenCalled();
    await act(async () => { t.unmount(); });
  });
  test('store: held for review (not counted, here or on the server) until the units are pulled; then checked and counted', async () => {
    await boot([], [], <><Today /><Review /></>);
    await act(async () => { st.addEntries([tableEntry('H', 'dal', 2, 'katori')]); }); await settle();
    expect(ent('H')).toMatchObject({ needs_review: true, reject_code: 'units_unknown', server_note: 'Check amount' });
    expect(counted(ent('H'))).toBe(false);
    expect(server.rows.get('H')).toMatchObject({ state: 'needs_review' }); expectInSync();
    expect(textOf(r)).toContain('Check amount');
    expect(entryRefusal({ ...ent('H'), needs_review: false, confirmed: true })).toBe(UNITS_UNKNOWN); // can't be confirmed yet
    // the server's table now has dal's units; the next sync pulls them (the held row asks for it)
    server.dishes = [{ id: 'dal', version: 3, supported_units: ['katori', 'spoon', 'plate', 'gram'] }];
    await act(async () => { st.addEntries([tableEntry('R', 'roti', 2, 'count')]); }); await settle(); await tick();
    expect(server.log.some((l) => l.path === '/v1/dishes')).toBe(true);
    expect(st.dishUnits?.units.dal).toEqual(['katori', 'spoon', 'plate', 'gram']);
    expect(parser.supportedUnits('dal')).toEqual(['katori', 'spoon', 'plate', 'gram']);
    let why: string | null = null;
    await act(async () => { why = st.confirmReview('H', { ...ent('H').review_item!, needs_confirmation: false }); });
    expect(why).toBeNull(); await settle();
    expect(counted(ent('H'))).toBe(true); expect(ent('H').kcal.best).toBe(parser.recompute('dal', 2, 'katori', '').kcal.best);
    expect(server.rows.get('H')).toMatchObject({ state: 'confirmed', unit: 'katori', qty: 2 }); expectInSync();
  });
});

describe('Designer copy: "isn’t measured in {unit plural}"', () => {
  test('plurals and both lines', () => {
    const { unitPlural, notMeasured } = require('../src/lib/domain');
    expect(['katori', 'spoon', 'plate', 'gram', 'piece', 'glass', 'litre'].map(unitPlural)).toEqual(['katoris', 'spoons', 'plates', 'grams', 'pieces', 'glasses', 'litres']);
    expect(notMeasured('dal', 'piece')).toBe('dal isn’t measured in pieces');
    expect(unitReason('glass', 'roti')).toBe('Roti isn’t measured in glasses. Pick another unit.');
    expect(unitReason('piece', 'kodo_khichdi')).toBe('Kodo khichdi isn’t measured in pieces. Pick another unit.'); // a dish the phone doesn't have: its id as words, never a slug
    const { reviewNote } = require('../src/lib/serverRow');
    expect(reviewNote(tableEntry('x', 'dal', 1, 'piece'))).toBe('Not counted yet: dal isn’t measured in pieces. Check the amount and add it again.');
  });
});
