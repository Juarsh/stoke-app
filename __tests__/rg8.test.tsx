// Tester rg8 (Oct 17).
// B2: a span the phone can't match goes to /v1/parse WITH its amount words ("1 plate zarda", never "1 zarda"); a table
//     answer whose qty/unit differs from what the phone read is flagged (unit check / review), never counted silently.
// B3: a delete the server keeps answering 5xx never holds back other ids (rows added after it reach the server in the same
//     flush); after 3 straight 5xx its row is flagged "Couldn’t sync this. Tap to retry" and says the server still has it.
// F-1: a row an older build synced (no server_counts), edited, then flagged by 3x 5xx counts exactly the server's numbers.
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

import { StoreProvider, Store, useStore } from '../src/lib/store';
import { counted, dayTotals, entryFromItem, FoodEntry, localDate } from '../src/lib/domain';
import { parser, DISH_TABLE_VERSION, Item } from '../src/parser';
import { ApiError } from '../src/lib/api';
import { flush, NOT_DELETED_REASON, Op, SERVER_ERROR } from '../src/lib/syncQueue';
import { amountDiffers, flagAmount, sentText } from '../src/lib/spanAmount';
import { resolvePending } from '../src/lib/pending';
import { kindOf } from '../src/lib/confirmBatch';
import Today from '../src/app/(tabs)/index';
import Log from '../src/app/(tabs)/log';
import rules from '../src/data/rules.json';

jest.setTimeout(30_000);
const DAY = localDate();
const texts = (t: ReactTestRenderer) => t.root.findAll((n) => typeof n.type === 'string').flatMap((n) => [n.props.children].flat()).filter((c) => typeof c === 'string') as string[];
const textOf = (t: ReactTestRenderer) => texts(t).join('').replace(/\s+/g, ' ');
const tableEntry = (id: string, dish: string, qty: number, unit: string, extra: Partial<FoodEntry> = {}): FoodEntry => {
  const it = { ...parser.recompute(dish, qty, unit, ''), needs_confirmation: false } as Item;
  return { ...entryFromItem(it, { id, slot: 'lunch', raw_text: `${qty} ${unit} ${dish}`, local_date: DAY, tableVersion: DISH_TABLE_VERSION }), qty, unit, ...extra };
};

// ---------- B2 ----------
const UNIT_RULES = (rules as unknown as { units: Record<string, { words: string[]; as?: string; factor?: number }> }).units;
describe('B2: an unmatched span keeps its amount words', () => {
  test('every unit word (all 7 units, plurals, aliases): the text sent has the word, and the phone reads qty + unit', () => {
    let n = 0;
    for (const [u, r] of Object.entries(UNIT_RULES)) {
      const unit = r.as ?? u, f = r.factor ?? 1;
      for (const w of r.words.filter((x) => !x.includes(' '))) { // multi-word aliases ('bada chammach') aren't one unit token
        for (const [q, qn] of [['1', 1], ['2', 2], ['1.5', 1.5], ['1/2', 0.5], ['half', 0.5], ['do', 2], ['ek', 1], ['two', 2]] as const) {
          const text = `${q} ${w} zarda`;
          const p = parser.parse(text);
          if (p.items.length) continue; // the word is also a food / alias ("thali" plate, etc.): not an unmatched span
          expect(p.unmatched).toHaveLength(1);
          const a = p.amounts?.[p.unmatched[0]];
          expect(a).toBeDefined();
          expect(a!.unit).toBe(unit);
          expect(a!.qty).toBeCloseTo(qn * f, 6);
          const sent = sentText(p.unmatched[0], p.amounts);
          expect(sent.endsWith(' zarda')).toBe(true);
          expect(` ${sent} `).toContain(` ${w} `); // the unit word as typed: never "1 zarda"
          n++;
        }
      }
    }
    expect(n).toBeGreaterThan(200);
    for (const u of ['count', 'katori', 'spoon', 'plate', 'glass', 'gram']) expect(Object.values(UNIT_RULES).some((r) => (r.as ?? '') === u) || u in UNIT_RULES).toBe(true);
  });
  test('no unit typed: qty only ("3 zarda"), nothing at all ("zarda"); a span after a matched dish keeps its own amount', () => {
    expect(parser.parse('3 zarda').amounts?.['3 zarda']).toEqual({ text: '3 zarda', qty: 3, unit: '' });
    expect(parser.parse('zarda').amounts).toBeUndefined();
    const p = parser.parse('2 roti aur 1 plate zarda');
    expect(p.items.map((i) => i.dish_id)).toEqual(['roti']);
    expect(sentText(p.unmatched[0], p.amounts)).toBe('1 plate zarda');
  });
  const zarda = (qty: number, unit: string, kcal: number): Item => ({ dish_id: 'zarda_pulao', name: 'zarda pulao', matched_text: 'plate zarda', quantity: qty, unit, grams: 0, oil_level: '',
    kcal: { low: kcal * 0.8, best: kcal, high: kcal * 1.2 }, protein_g: { low: 4, best: 5, high: 6 }, carbs_g: 0, fat_g: 0, source: 'table', data_source: 'table', source_note: '',
    fuzzy: false, needs_confirmation: false, default_portion: false, span_start: 0, span_end: 13, ai_estimate: false } as Item);
  test('flag rule: the server answering another unit or qty than the phone read is a unit check (not counted); the same amount is not', () => {
    const a = { qty: 1, unit: 'plate' };
    expect(amountDiffers(zarda(1, 'plate', 640), a)).toBe(false);
    expect(amountDiffers(zarda(1, 'katori', 320), a)).toBe(true);
    expect(amountDiffers(zarda(2, 'plate', 1280), a)).toBe(true);
    expect(amountDiffers({ ...zarda(1, 'katori', 320), ai_estimate: true }, a)).toBe(false); // AI rows are open rows anyway
    expect(amountDiffers(zarda(1, 'katori', 320), { qty: 1, unit: '' })).toBe(false); // no unit typed: the server's default
    expect(kindOf(flagAmount(zarda(1, 'katori', 320), a) as never, false)).toBe('unit');
    expect(kindOf(flagAmount(zarda(1, 'plate', 640), a) as never, false)).toBe('counted');
  });
  test('a queued (offline / handed-off) span: resolved with its amount; a differing answer is saved for review, never counted', async () => {
    const f = { id: 'P', span: '1 plate zarda', slot: 'lunch' as const, local_date: DAY, raw_text: '1 plate zarda', amount: { qty: 1, unit: 'plate' } };
    const api = (it: Item) => ({ parse: jest.fn(async () => ({ items: [it], unmatched: [], total: {} as never, used_ai: false, needs_confirmation: false, fallback: 'none' as const, custom_items: [], slot: 'lunch' as const })) });
    const ok = api(zarda(1, 'plate', 640));
    const good = await resolvePending(ok, f) as FoodEntry[];
    expect(ok.parse).toHaveBeenCalledWith('1 plate zarda', true);
    expect(good[0]).toMatchObject({ qty: 1, unit: 'plate' }); expect(counted(good[0])).toBe(true); expect(good[0].kcal.best).toBe(640);
    const bad = await resolvePending(api(zarda(1, 'katori', 320)), f) as FoodEntry[];
    expect(bad[0].needs_review).toBe(true); expect(counted(bad[0])).toBe(false);
  });
});

// ---------- Log: what goes to /v1/parse, and what the row shows ----------
const server = { log: [] as { method: string; path: string; body: Record<string, any> }[], answerUnit: 'plate' as string | null, del5xx: new Set<string>(), rows: new Map<string, { kcal: number }>(),
  down: false, patch5xx: false,
  reset() { this.log = []; this.answerUnit = 'plate'; this.del5xx.clear(); this.rows.clear(); this.down = false; this.patch5xx = false; } };
const reply = (status: number, body: unknown = {}) => ({ ok: status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
const PULLED = [{ id: 'zarda_pulao', name: 'zarda pulao', version: DISH_TABLE_VERSION, supported_units: ['katori', 'plate', 'gram'] }];
async function fakeFetch(url: string, init: { method: string; body?: string }) {
  const path = url.replace('http://api.test', ''); const b = init.body ? JSON.parse(init.body) : {};
  if (server.down) throw new TypeError('Network request failed');
  server.log.push({ method: init.method, path, body: b });
  if (path === '/v1/remembered') return reply(200, { remembered: [] });
  if (path === '/v1/dishes') return reply(200, PULLED);
  if (path === '/v1/parse') {
    // the server reads what it is sent: "1 plate zarda" -> 1 plate; a bare "1 zarda" -> the default katori
    const plate = /\bplates?\b/.test(b.text) && server.answerUnit === 'plate';
    const it = { dish_id: 'zarda_pulao', name: 'zarda pulao', matched_text: 'zarda', quantity: 1, unit: plate ? 'plate' : 'katori', grams: 0, oil_level: '',
      kcal: { low: 0, best: plate ? 640 : 320, high: 0 }, protein_g: { low: 0, best: 5, high: 0 }, carbs_g: 0, fat_g: 0, source: 'table', data_source: 'table', source_note: '',
      fuzzy: false, needs_confirmation: false, default_portion: false, span_start: 0, span_end: 5, ai_estimate: false };
    return reply(200, { items: [it], unmatched: [], used_ai: false, fallback: 'none', ai_state: 'none', custom_items: [] });
  }
  if (init.method === 'POST' && path === '/v1/entries') {
    if (server.patch5xx) return reply(500, { error: 'save failed' });
    const it = b.items[0]; server.rows.set(it.client_id, { kcal: Number(it.kcal ?? 0) });
    return reply(201, { entries: [{ version: 1, state: 'confirmed', qty: it.qty, unit: it.unit, kcal_best: it.kcal ?? 0, protein_best: 0 }] });
  }
  const m = /^\/v1\/entries\/(.+)$/.exec(path); const id = m ? decodeURIComponent(m[1]) : '';
  if (init.method === 'DELETE') { if (server.del5xx.has(id)) return reply(503, { error: 'unavailable' }); server.rows.delete(id); return reply(204); }
  if (server.patch5xx) return reply(500, { error: 'save failed' });
  return reply(200, { version: 2, state: 'confirmed', kcal_best: b.kcal ?? 0, protein_best: 0 });
}
let st!: Store;
function Probe() { st = useStore(); return null; }
const tick = async (n = 12) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((res) => setTimeout(res, 0)); }); };
let r!: ReactTestRenderer;
async function boot(ui?: React.ReactNode, entries: FoodEntry[] = [], queue: Op[] = []) {
  mockN = 0;
  mockSaved = JSON.stringify({ user: { id: 'u', name: 'A', email: 'a@x', idToken: 't', mock: false }, entries, queue, aiQuota: { used: 0 } });
  await act(async () => { r = create(<StoreProvider><Probe />{ui}</StoreProvider>); });
  await tick();
}
beforeAll(() => { (global as unknown as { fetch: unknown }).fetch = jest.fn(fakeFetch); });
beforeEach(() => { server.reset(); parser.setPulledUnits(null); });
afterEach(async () => { await act(async () => { r?.unmount(); }); parser.setPulledUnits(null); });

describe('B2 on the Log screen', () => {
  async function typeIt(text: string) {
    const input = r.root.findAll((n) => n.type === TextInput && n.props.accessibilityLabel === 'What did you eat?')[0];
    await act(async () => { input.props.onChangeText(text); });
    await act(async () => { await new Promise((res) => setTimeout(res, 800)); }); await tick();
  }
  const addLabel = () => String(r.root.findAll((n) => typeof n.props.title === 'string' && /^(Add|Save)/.test(n.props.title))[0]?.props.title ?? '');
  test('"1 plate zarda" is sent whole and reads 1 plate · 640 (not 1 katori · 320); "2 plates zarda" too', async () => {
    parser.setPulledUnits({ zarda_pulao: ['katori', 'plate', 'gram'] }, DISH_TABLE_VERSION, { zarda_pulao: 'zarda pulao' });
    await boot(<Log />);
    await typeIt('1 plate zarda');
    expect(server.log.filter((l) => l.path === '/v1/parse').map((l) => l.body.text)).toEqual(['1 plate zarda']);
    expect(textOf(r)).toContain('Zarda pulao'); expect(textOf(r)).toContain('1 plate');
    expect(textOf(r)).toContain('640'); expect(textOf(r)).not.toContain('not counted'); expect(textOf(r)).not.toContain('320');
    expect(textOf(r)).toContain('Read as zarda pulao'); expect(textOf(r)).not.toMatch(/· check/i); // the Check badge isn't repeated
    await typeIt('2 plates zarda');
    expect(server.log.filter((l) => l.path === '/v1/parse').map((l) => l.body.text)).toContain('2 plates zarda');
  });
  test('a server answering another amount than typed: a unit check, not counted (never "Add 320 kcal")', async () => {
    parser.setPulledUnits({ zarda_pulao: ['katori', 'plate', 'gram'] }, DISH_TABLE_VERSION, { zarda_pulao: 'zarda pulao' });
    server.answerUnit = null; // this server ignores the unit
    await boot(<Log />);
    await typeIt('1 plate zarda');
    expect(addLabel()).not.toContain('320');
    expect(textOf(r)).toContain('not counted');
  });
});

describe('Designer copy (rg8 F-4 items in scope)', () => {
  test('a disabled Add over the ceiling says why under it', async () => {
    await boot(<Log />);
    const input = r.root.findAll((n) => n.type === TextInput && n.props.accessibilityLabel === 'What did you eat?')[0];
    await act(async () => { input.props.onChangeText('100 roti'); }); await tick();
    const pick = r.root.findAll((n) => typeof n.props.onPress === 'function' && /100 pieces/.test(String(n.props.accessibilityLabel ?? '')));
    if (pick.length) await act(async () => { pick[pick.length - 1].props.onPress(); }); // a big count asks first: "Looks right"
    await tick();
    const add = r.root.findAll((n) => typeof n.type === 'string' && n.props.accessibilityRole === 'button' && /^Add 11,000 kcal/.test(String(n.props.accessibilityLabel ?? '')));
    expect(add.length).toBeGreaterThan(0);
    expect(add[add.length - 1].props.accessibilityState?.disabled).toBe(true);
    const why = r.root.findAll((n) => n.props.testID === 'add-blocked' && typeof n.type !== 'string');
    expect(why.length).toBeGreaterThan(0);
    expect(textOf(r)).toContain('That’s too much for one entry. Try a smaller amount.');
    await act(async () => { input.props.onChangeText('2 roti'); }); await tick();
    expect(r.root.findAll((n) => n.props.testID === 'add-blocked')).toHaveLength(0);
  });
  test('"Read as" shows the amount once, and a Check card doesn’t repeat "check"', async () => {
    const { ConfirmCard } = require('../src/components/ConfirmCard');
    const it = { ...parser.unknown('x'), dish_id: 'kodo_khichdi', name: '1 katori kodo khichdi', matched_text: '1 katori kodo khichdi', quantity: 1, unit: 'katori', source: 'table', ai_estimate: false,
      kcal: { low: 200, best: 250, high: 300 }, needs_confirmation: true } as Item;
    let t!: ReactTestRenderer;
    await act(async () => { t = create(<ConfirmCard it={it} onResolve={() => {}} onRemove={() => {}} />); });
    const txt = textOf(t);
    expect(txt).toContain('Read as: kodo khichdi · 1 katori');
    expect(txt).not.toContain('1 katori kodo khichdi ·');
    expect(texts(t).filter((x) => x.trim().toLowerCase() === 'check')).toHaveLength(1); // the badge only
    await act(async () => { t.unmount(); });
  });
});

// ---------- B3 ----------
describe('B3: a failing delete never holds back other ids', () => {
  const sender = (failDel: Set<string>) => ({
    upsertEntry: jest.fn(async (e: FoodEntry) => ({ version: 1, row: { state: 'confirmed', kcal_best: e.kcal.best, protein_best: e.protein_g.best } })),
    deleteEntry: jest.fn(async (id: string) => { if (failDel.has(id)) throw new ApiError(500, '{"error":"delete failed"}'); }),
    resolvePending: jest.fn(async () => null), deleteRemembered: jest.fn(async () => {}),
  });
  test('rows added after a parked delete reach the server in the same flush (while it backs off); per-id order holds', async () => {
    const s = sender(new Set(['D']));
    let q: Op[] = [{ kind: 'delete', id: 'D', tries: 0 }, { kind: 'upsert', entry: tableEntry('A', 'roti', 1, 'count'), tries: 0 }];
    let now = 1_000;
    let res = await flush(q, s, now);
    expect(s.upsertEntry.mock.calls.map((c) => c[0].id)).toEqual(['A']);
    q = res.rest; expect(q).toHaveLength(1); expect(q[0]).toMatchObject({ kind: 'delete', id: 'D', fives: 1 });
    // later: new rows while D backs off (nextAt in the future) -> they go now, not after D's backoff
    now += 1_000;
    q = [...q, { kind: 'upsert', entry: tableEntry('B', 'dal', 1, 'katori'), tries: 0 }, { kind: 'upsert', entry: tableEntry('C', 'roti', 2, 'count'), tries: 0 }];
    res = await flush(q, s, now);
    expect(s.upsertEntry.mock.calls.map((c) => c[0].id)).toEqual(['A', 'B', 'C']);
    expect(res.rest.map((o) => o.kind)).toEqual(['delete']);
    // an op on the SAME id as the parked delete waits behind it (per-id order)
    res = await flush([...res.rest, { kind: 'upsert', entry: tableEntry('D', 'roti', 1, 'count'), tries: 0 }], s, now);
    expect(s.upsertEntry.mock.calls.map((c) => c[0].id)).toEqual(['A', 'B', 'C']);
    expect(res.rest.map((o) => o.kind)).toEqual(['delete', 'upsert']);
  });
  test('no connection still stops the flush (nothing is skipped past a network failure)', async () => {
    const s = { ...sender(new Set()), deleteEntry: jest.fn(async () => { throw new TypeError('Network request failed'); }) };
    const res = await flush([{ kind: 'delete', id: 'D', tries: 0 }, { kind: 'upsert', entry: tableEntry('A', 'roti', 1, 'count'), tries: 0 }], s, 1);
    expect(s.upsertEntry).not.toHaveBeenCalled(); expect(res.rest).toHaveLength(2);
  });
  test('Today: 3 straight 5xx on a delete -> the row says "Couldn’t sync this. Tap to retry" and that the server still has it; rows added later sync; tap retries', async () => {
    const d = { ...tableEntry('D', 'roti', 1, 'count'), server_version: 1, server_counts: { kcal: 110, protein: 3 } };
    server.del5xx.add('D');
    await boot(<Today />, [d]);
    await act(async () => { st.deleteEntry('D'); }); await tick();
    // three flushes, each later than D's backoff; a new row added in between reaches the server at once
    let added = false;
    for (let i = 0; i < 6 && !st.entries.find((x) => x.id === 'D')?.sync_error; i++) {
      jest.spyOn(Date, 'now').mockReturnValue(Date.now() + (i + 1) * 3_600_000);
      await act(async () => { await st.sync(); }); await tick();
      if (!added) { added = true; await act(async () => { st.addEntries([tableEntry('N', 'dal', 1, 'katori')]); }); await act(async () => { await st.sync(); }); await tick(); expect(server.rows.has('N')).toBe(true); }
      (Date.now as jest.Mock).mockRestore?.();
    }
    const row = st.entries.find((x) => x.id === 'D')!;
    expect(row).toMatchObject({ sync_error: SERVER_ERROR, sync_reason: NOT_DELETED_REASON });
    expect(st.queue.some((o) => o.kind === 'delete')).toBe(false);
    expect(textOf(r)).toContain('Couldn’t sync this. Tap to retry');
    expect(textOf(r)).toContain(NOT_DELETED_REASON);
    expect(textOf(r)).toContain('(deleted)');
    server.del5xx.clear();
    const tap = r.root.findAll((n) => typeof n.props.onPress === 'function' && /\(deleted\): couldn’t sync this/i.test(String(n.props.accessibilityLabel ?? '')));
    expect(tap.length).toBeGreaterThan(0);
    await act(async () => { tap[0].props.onPress(); }); await act(async () => { await st.sync(); }); await tick();
    expect(st.entries.find((x) => x.id === 'D')!.sync_error).toBeUndefined();
    expect(server.log.filter((l) => l.method === 'DELETE').length).toBeGreaterThanOrEqual(4);
  });
});

// ---------- F-1 ----------
describe('F-1: a row an older build synced counts exactly what the server has when flagged', () => {
  test('edited, then 3x 5xx: counts the server’s 220, not 0 (and never the unsaved edit)', async () => {
    const old = { ...tableEntry('O', 'roti', 2, 'count'), server_version: 3 }; // synced by an older build: no server_counts
    delete (old as Partial<FoodEntry>).server_counts;
    server.patch5xx = true;
    await boot(<Today />, [old]);
    expect(st.entries.find((x) => x.id === 'O')!.server_counts).toEqual({ kcal: old.kcal.best, protein: old.protein_g.best }); // seeded at load
    const k = old.kcal.best;
    await act(async () => { st.updateEntry({ ...tableEntry('O', 'roti', 4, 'count'), server_version: 3 }); }); await tick();
    for (let i = 0; i < 6 && !st.entries.find((x) => x.id === 'O')!.server_failed; i++) {
      const t0 = Date.now(); const spy = jest.spyOn(Date, 'now').mockReturnValue(t0 + (i + 1) * 3_600_000);
      await act(async () => { await st.sync(); }); await tick(); spy.mockRestore();
    }
    const o = st.entries.find((x) => x.id === 'O')!;
    expect(o).toMatchObject({ server_failed: true, sync_error: SERVER_ERROR });
    expect(server.log.filter((l) => l.path === '/v1/entries').length).toBe(3);
    expect(dayTotals(st.entries).kcal).toBe(Math.round(k)); // the server's 2 roti (220), not 0 and not the 4-roti edit
    expect(textOf(r)).toContain(`${Math.round(k)} kcal`); expect(textOf(r)).not.toContain('not counted');
  });
  test('an older-build row edited BEFORE this build (still queued at load) is not guessed: nothing is seeded for it', async () => {
    const old = { ...tableEntry('Q', 'roti', 2, 'count'), server_version: 3 };
    server.down = true; // offline: the queued edit stays queued
    await boot(undefined, [old], [{ kind: 'upsert', entry: old, tries: 0 }]);
    expect(st.entries.find((x) => x.id === 'Q')!.server_counts).toBeUndefined();
  });
});
