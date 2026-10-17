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
const server = { log: [] as { method: string; path: string; body: Record<string, any> }[], answerUnit: 'plate' as string | null, del5xx: new Set<string>(), rows: new Map<string, { kcal: number; protein?: number; qty?: number; unit?: string; version?: number; state?: string }>(),
  down: false, patch5xx: false, getDown: false, delAnswer: new Map<string, { status: number; body: unknown }[]>(),
  reset() { this.log = []; this.answerUnit = 'plate'; this.del5xx.clear(); this.rows.clear(); this.down = false; this.patch5xx = false; this.getDown = false; this.delAnswer.clear(); } };
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
  // next-build edge (a): GET one row = the server's copy (404 when it has none)
  if (init.method === 'GET' && m) {
    if (server.getDown) return reply(503, { error: 'unavailable' });
    const row = server.rows.get(id);
    return row ? reply(200, { version: row.version ?? 1, state: row.state ?? 'confirmed', qty: row.qty, unit: row.unit, kcal_best: row.kcal, protein_best: row.protein ?? 0 }) : reply(404, { error: 'entry not found' });
  }
  if (init.method === 'DELETE' && server.delAnswer.get(id)?.length) { const a = server.delAnswer.get(id)!.shift()!; if (a.status < 300) server.rows.delete(id); return reply(a.status, a.body); }
  if (init.method === 'DELETE') { if (server.del5xx.has(id)) return reply(503, { error: 'unavailable' }); server.rows.delete(id); return reply(204); }
  if (server.patch5xx) return reply(500, { error: 'save failed' });
  const prev = server.rows.get(id);
  if (prev && init.method === 'PATCH') server.rows.set(id, { ...prev, kcal: Number(b.kcal ?? prev.kcal), qty: b.qty ?? prev.qty, unit: b.unit ?? prev.unit, version: (prev.version ?? 1) + 1 });
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
    const it2 = { ...it, matched_text: 'kodo khichdi' } as Item; await act(async () => { t.update(<ConfirmCard it={it2} onResolve={() => {}} onRemove={() => {}} />); });
    expect(textOf(t)).not.toContain('You typed “kodo khichdi”'); // it reads as what was typed: not repeated
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

// ---------- rg9 B3: a flagged failed delete counts what the server still has ----------
import Progress from '../src/app/(tabs)/progress';
import { addDays, loggedDays, plateRows } from '../src/lib/domain';
import { applyFlush } from '../src/lib/store';
describe('rg9 B3: a delete flagged after 3x 5xx is counted at the server’s numbers until it gets through', () => {
  const plateLabel = (slot: string) => r.root.findAll((n) => typeof n.props.accessibilityLabel === 'string' && new RegExp(`^${slot}: `).test(n.props.accessibilityLabel)).map((n) => n.props.accessibilityLabel as string)[0] ?? '';
  const flagIt = async (id: string) => {
    for (let i = 0; i < 6 && !st.entries.find((x) => x.id === id)?.sync_error; i++) {
      const spy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + (i + 1) * 3_600_000);
      await act(async () => { await st.sync(); }); await tick(); spy.mockRestore();
    }
  };
  const roti = () => ({ ...tableEntry('F', 'roti', 2, 'count', { slot: 'breakfast' }), server_version: 1, server_counts: { kcal: 220, protein: 7 } });
  const dal = () => ({ ...tableEntry('G', 'dal', 1, 'katori', { slot: 'breakfast' }), server_version: 1 });
  test('pending: hidden (optimistic); flagged: phone total, Breakfast sum and the flagged row all show the server’s 220; retry success removes it', async () => {
    const F = roti(), G = dal(), g = Math.round(G.kcal.best);
    server.del5xx.add('F');
    await boot(<Today />, [F, G]);
    expect(dayTotals(st.entries).kcal).toBe(220 + g);
    await act(async () => { st.deleteEntry('F'); }); await tick();
    // the first 5xx: not flagged yet -> hidden at once (the phone may be ahead of the server only while it is still trying)
    const f1 = st.entries.find((x) => x.id === 'F')!;
    expect(f1.sync_error).toBeUndefined(); expect(counted(f1)).toBe(false);
    expect(dayTotals(st.entries).kcal).toBe(g);
    await flagIt('F');
    const f = st.entries.find((x) => x.id === 'F')!;
    expect(f).toMatchObject({ sync_error: SERVER_ERROR, sync_reason: NOT_DELETED_REASON, delete_failed: true, server_counts: { kcal: 220, protein: 7 } });
    expect(counted(f)).toBe(true);
    expect(dayTotals(st.entries).kcal).toBe(220 + g); // = the server's day
    expect(plateRows(st.entries.filter(counted), (e) => e.dish_id ?? '').find((x) => x.slot === 'breakfast')?.kcal).toBe(220 + g);
    expect(loggedDays(st.entries).has(DAY)).toBe(true);
    const txt = textOf(r);
    expect(txt).toContain('(deleted)'); expect(txt).toContain('220 kcal'); expect(txt).toContain(NOT_DELETED_REASON); expect(txt).not.toContain('not counted');
    expect(plateLabel('Breakfast')).toMatch(new RegExp(`${220 + g} calories$`));
    // tap retry -> the delete gets through -> gone from the counts (and the flag)
    server.del5xx.clear();
    const tap = r.root.findAll((n) => typeof n.props.onPress === 'function' && /\(deleted\): couldn’t sync this/i.test(String(n.props.accessibilityLabel ?? '')));
    await act(async () => { tap[0].props.onPress(); });
    await act(async () => { await st.sync(); }); await tick();
    const done = st.entries.find((x) => x.id === 'F')!;
    expect(done.delete_failed).toBeUndefined(); expect(done.sync_error).toBeUndefined(); expect(counted(done)).toBe(false);
    expect(dayTotals(st.entries).kcal).toBe(g);
    expect(textOf(r)).not.toContain('(deleted)'); expect(plateLabel('Breakfast')).toMatch(new RegExp(`${g} calories$`));
  });
  test('a retry that 5xx-es again stays counted and flagged (never silently dropped)', async () => {
    server.del5xx.add('F');
    await boot(<Today />, [roti()]);
    await act(async () => { st.deleteEntry('F'); }); await tick(); await flagIt('F');
    await act(async () => { st.retrySync('F'); }); await tick(); await flagIt('F');
    expect(st.entries.find((x) => x.id === 'F')).toMatchObject({ delete_failed: true, sync_error: SERVER_ERROR });
    expect(dayTotals(st.entries).kcal).toBe(220);
  });
  test('an older-build row (no server_counts) deleted then flagged counts the row the server recorded, not 0', async () => {
    const old = { ...tableEntry('O', 'roti', 2, 'count'), server_version: 3 } as FoodEntry; delete (old as Partial<FoodEntry>).server_counts;
    server.del5xx.add('O'); server.rows.set('O', { kcal: old.kcal.best, protein: old.protein_g.best, version: 3 });
    await boot(<Today />, [old], [{ kind: 'upsert', entry: { ...old, server_version: 3 }, tries: 0, nextAt: Date.now() + 3_600_000 } as Op]);
    expect(st.entries.find((x) => x.id === 'O')!.server_counts).toBeUndefined(); // queued edit at load: not guessed
    await act(async () => { st.deleteEntry('O'); }); await tick(); await flagIt('O');
    // a queued upsert was not seeded: no guess. Next build edge (a): once flagged, the server's copy is fetched and counted
    const o = st.entries.find((x) => x.id === 'O')!;
    expect(o.delete_failed).toBe(true); expect(o.server_counts).toEqual({ kcal: old.kcal.best, protein: old.protein_g.best });
    expect(dayTotals(st.entries).kcal).toBe(Math.round(old.kcal.best));
    expect(textOf(r)).toContain('(deleted)'); expect(textOf(r)).toContain(NOT_DELETED_REASON); expect(textOf(r)).not.toContain('not counted');
  });
  test('an older-build row with nothing queued: deleting it records what the server has first', async () => {
    const old = { ...tableEntry('P', 'roti', 2, 'count'), server_version: 3 } as FoodEntry; delete (old as Partial<FoodEntry>).server_counts;
    server.del5xx.add('P');
    await boot(<Today />, [old]);
    await act(async () => { st.deleteEntry('P'); }); await tick(); await flagIt('P');
    expect(dayTotals(st.entries).kcal).toBe(Math.round(old.kcal.best));
  });
  test('pure applyFlush: a 5xx-flagged delete counts while it backs off; a success clears the flag (4xx refusals: rg10 below)', () => {
    const F = { ...roti(), deleted_at: '2026-10-17T05:00:00Z' };
    const flagged = applyFlush({ entries: [F], queue: [] }, [{ kind: 'delete', id: 'F', tries: 0 }], { rest: [], resolved: [], rejected: [], versions: {}, gone: [], failed: [{ id: 'F', code: SERVER_ERROR, reason: NOT_DELETED_REASON }] } as never);
    expect(flagged.entries[0]).toMatchObject({ delete_failed: true, server_failed: true }); expect(dayTotals(flagged.entries).kcal).toBe(220);
    const parked = applyFlush(flagged, [{ kind: 'delete', id: 'F', tries: 0 }], { rest: [{ kind: 'delete', id: 'F', tries: 1, fives: 1 }], resolved: [], rejected: [], versions: {}, gone: [], failed: [] } as never);
    expect(parked.entries[0].delete_failed).toBe(true); // still backing off: still on the server
    const ok = applyFlush(flagged, [{ kind: 'delete', id: 'F', tries: 0 }], { rest: [], resolved: [], rejected: [], versions: {}, gone: [], failed: [] } as never);
    expect(ok.entries[0].delete_failed).toBeUndefined(); expect(dayTotals(ok.entries).kcal).toBe(0);
  });
  test('Progress: a past day with a flagged delete shows the server’s total, and its row says (deleted)', async () => {
    const y = addDays(DAY, -1);
    const F = { ...roti(), local_date: y, deleted_at: `${y}T05:00:00Z`, server_failed: true, delete_failed: true, sync_error: SERVER_ERROR, sync_reason: NOT_DELETED_REASON };
    const G = { ...dal(), local_date: y };
    await boot(<Progress />, [F, G]);
    const day = r.root.findAll((n) => typeof n.props.accessibilityLabel === 'string' && /, 2 items, /.test(n.props.accessibilityLabel));
    expect(day.length).toBeGreaterThan(0);
    expect(day[0].props.accessibilityLabel).toContain(`${220 + Math.round(G.kcal.best)} calories`);
    await act(async () => { day[0].props.onPress(); });
    expect(textOf(r)).toContain('(deleted)');
  });
});

// ---------- rg10 (CEO): a delete the server refuses with a 4xx other than 404 -> the row stays (restored, counted, says why) ----------
import { KEPT_COPY, keptNote, restoreKept } from '../src/lib/store';
describe('rg10: a delete refused with a 4xx (not 404) restores the row at the server’s numbers with the server’s reason', () => {
  const F = () => ({ ...tableEntry('F', 'roti', 2, 'count', { slot: 'breakfast' }), server_version: 1, server_counts: { kcal: 220, protein: 7 } });
  const G = () => ({ ...tableEntry('G', 'dal', 1, 'katori', { slot: 'breakfast' }), server_version: 1 });
  const seedServer = (...es: FoodEntry[]) => es.forEach((e) => server.rows.set(e.id, { kcal: e.server_counts?.kcal ?? e.kcal.best }));
  const serverTotal = () => Math.round([...server.rows.values()].reduce((a, x) => a + x.kcal, 0));
  const dels = () => server.log.filter((l) => l.method === 'DELETE').length;
  const LOCKED = { error: { code: 'forbidden', message: 'This entry is locked.' } };
  test('403 with a reason: restored (no deleted_at, no delete op), phone == server, Today says why; edit and delete again work', async () => {
    const f = F(), g = G(); seedServer(f, g);
    server.delAnswer.set('F', [{ status: 403, body: LOCKED }]);
    await boot(<Today />, [f, g]);
    await act(async () => { st.deleteEntry('F'); }); await tick();
    const row = st.entries.find((x) => x.id === 'F')!;
    expect(row.deleted_at).toBeNull(); expect(row.sync_error).toBeUndefined(); expect(row.delete_failed).toBeUndefined();
    expect(row.server_note).toBe(`${KEPT_COPY} This entry is locked.`);
    expect(st.queue.some((o) => o.kind === 'delete')).toBe(false);
    expect(counted(row)).toBe(true);
    expect(dayTotals(st.entries).kcal).toBe(serverTotal()); expect(serverTotal()).toBe(220 + Math.round(g.kcal.best));
    expect(textOf(r)).toContain('Not deleted: the server kept this entry. This entry is locked.');
    expect(textOf(r)).not.toContain('(deleted)'); expect(textOf(r)).not.toContain('Couldn’t sync this');
    // the row shows what it counts; OK dismisses the note (the row stays, still counted)
    expect(r.root.find((n) => n.props.testID === 'server-note-kcal' && typeof n.type !== 'string').props.children).toBe('220 kcal');
    await act(async () => { r.root.find((n) => n.props.testID === 'server-note-ok' && typeof n.props.onPress === 'function').props.onPress(); }); await tick();
    expect(st.entries.find((x) => x.id === 'F')!.server_note).toBeUndefined(); expect(textOf(r)).not.toContain(KEPT_COPY);
    expect(dayTotals(st.entries).kcal).toBe(serverTotal());
    // edit works as on any row (PATCH, note cleared, counted at what the server saved)
    const n0 = server.log.length;
    let why: string | null = 'x';
    await act(async () => { why = st.updateEntry({ ...st.entries.find((x) => x.id === 'F')!, ...tableEntry('F', 'roti', 3, 'count', { slot: 'breakfast' }), server_version: 1 }); }); await tick();
    expect(why).toBeNull();
    expect(server.log.slice(n0).some((l) => l.path.startsWith('/v1/entries') && l.method !== 'DELETE' && l.method !== 'GET')).toBe(true); // the edit was sent
    expect(st.queue).toHaveLength(0);
    const ed = st.entries.find((x) => x.id === 'F')!;
    expect(ed.server_note ?? '').not.toContain(KEPT_COPY); expect(ed.kept_on_server).toBeUndefined(); expect(ed.sync_error).toBeUndefined();
    // and it can be deleted again (this time the server takes it)
    await act(async () => { st.deleteEntry('F'); }); await tick();
    expect(counted(st.entries.find((x) => x.id === 'F')!)).toBe(false); expect(server.rows.has('F')).toBe(false);
    expect(dayTotals(st.entries).kcal).toBe(serverTotal());
  });
  test('every refusing 4xx (400, 403, 409 twice, 410, 422) restores; a reason-less body gets the plain copy', async () => {
    for (const status of [400, 403, 409, 410, 422]) {
      server.reset(); const f = F(); seedServer(f);
      server.delAnswer.set('F', status === 409 ? [{ status, body: { error: 'forbidden' } }, { status, body: { error: 'forbidden' } }] : [{ status, body: { error: 'forbidden' } }]);
      await boot(<Today />, [f]);
      await act(async () => { st.deleteEntry('F'); }); await tick();
      const row = st.entries.find((x) => x.id === 'F')!;
      expect([status, row.deleted_at, row.server_note]).toEqual([status, null, KEPT_COPY]);
      expect(dayTotals(st.entries).kcal).toBe(220);
      await act(async () => { r.unmount(); });
    }
  });
  test('404: the row is already gone on the server: the delete wins (not restored, not counted, no note)', async () => {
    const f = F(); server.delAnswer.set('F', [{ status: 404, body: { error: 'entry not found' } }]);
    await boot(<Today />, [f]);
    await act(async () => { st.deleteEntry('F'); }); await tick();
    const row = st.entries.find((x) => x.id === 'F')!;
    expect(row.deleted_at).toBeTruthy(); expect(row.server_note).toBeUndefined(); expect(row.sync_error).toBeUndefined();
    expect(counted(row)).toBe(false); expect(st.queue).toHaveLength(0); expect(dayTotals(st.entries).kcal).toBe(0);
  });
  test('401 / 429 are not refusals: retried later (the row stays deleted on the phone while it waits)', async () => {
    for (const status of [401, 429]) {
      server.reset(); server.delAnswer.set('F', [{ status, body: { error: 'later' } }]);
      await boot(undefined, [F()]);
      await act(async () => { st.deleteEntry('F'); }); await tick();
      const row = st.entries.find((x) => x.id === 'F')!;
      expect(row.deleted_at).toBeTruthy(); expect(row.server_note).toBeUndefined(); expect(st.queue.some((o) => o.kind === 'delete')).toBe(true);
      await act(async () => { r.unmount(); });
    }
  });
  test('409 version_conflict with the server’s copy: retried once at once; still 409 -> restored as the server has it; 409 then 204 -> deleted', async () => {
    const copy = { version: 5, state: 'confirmed', dish_id: 'roti', qty: 3, unit: 'count', kcal_best: 330, protein_best: 10 };
    server.delAnswer.set('F', [{ status: 409, body: { error: { code: 'version_conflict', message: 'entry changed' }, entry: copy } }, { status: 409, body: { error: { code: 'version_conflict' }, entry: copy } }]);
    server.rows.set('F', { kcal: 330 });
    await boot(<Today />, [F()]);
    await act(async () => { st.deleteEntry('F'); }); await tick();
    expect(dels()).toBe(2);
    const row = st.entries.find((x) => x.id === 'F')!;
    expect(row).toMatchObject({ deleted_at: null, server_version: 5, qty: 3, server_counts: { kcal: 330, protein: 10 } });
    expect(row.kcal.best).toBe(330); expect(dayTotals(st.entries).kcal).toBe(330); expect(row.server_note).toBe(`${KEPT_COPY} Entry changed.`);
    await act(async () => { r.unmount(); });
    server.reset(); server.delAnswer.set('F', [{ status: 409, body: { error: { code: 'version_conflict' } } }, { status: 204, body: {} }]);
    await boot(undefined, [F()]);
    await act(async () => { st.deleteEntry('F'); }); await tick();
    expect(dels()).toBe(2); expect(counted(st.entries.find((x) => x.id === 'F')!)).toBe(false); expect(st.queue).toHaveLength(0);
  });
  test('a flagged 5xx delete that is then refused (4xx) on retry is restored, no longer flagged', async () => {
    server.del5xx.add('F'); const f = F(); seedServer(f);
    await boot(<Today />, [f]);
    await act(async () => { st.deleteEntry('F'); }); await tick();
    for (let i = 0; i < 6 && !st.entries.find((x) => x.id === 'F')?.sync_error; i++) {
      const spy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + (i + 1) * 3_600_000);
      await act(async () => { await st.sync(); }); await tick(); spy.mockRestore();
    }
    expect(st.entries.find((x) => x.id === 'F')!.delete_failed).toBe(true);
    server.del5xx.clear(); server.delAnswer.set('F', [{ status: 403, body: LOCKED }]);
    await act(async () => { st.retrySync('F'); }); await tick();
    const row = st.entries.find((x) => x.id === 'F')!;
    expect(row).toMatchObject({ deleted_at: null, server_note: `${KEPT_COPY} This entry is locked.` });
    expect(row.delete_failed).toBeUndefined(); expect(row.sync_error).toBeUndefined(); expect(row.sync_retrying).toBeUndefined();
    expect(dayTotals(st.entries).kcal).toBe(220); expect(textOf(r)).not.toContain('(deleted)');
  });
  test('restoreKept (pure): server_counts win over the phone’s numbers; unknown -> the row as the server last confirmed it; review rows go back to Review', () => {
    const del = (e: FoodEntry) => ({ ...e, deleted_at: '2026-10-17T05:00:00Z' });
    const a = restoreKept(del({ ...tableEntry('A', 'roti', 4, 'count'), server_version: 2, server_counts: { kcal: 220, protein: 7 } }), { id: 'A', code: 'forbidden' });
    expect(a).toMatchObject({ deleted_at: null, server_failed: true, kept_on_server: true }); expect(dayTotals([a]).kcal).toBe(220);
    const old = { ...tableEntry('B', 'roti', 2, 'count'), server_version: 3 } as FoodEntry; delete (old as Partial<FoodEntry>).server_counts;
    const b = restoreKept(del(old), { id: 'B', code: 'forbidden', reason: 'locked' });
    expect(b.server_counts).toEqual({ kcal: old.kcal.best, protein: old.protein_g.best }); expect(b.server_note).toBe(`${KEPT_COPY} Locked.`); expect(dayTotals([b]).kcal).toBe(Math.round(old.kcal.best));
    const rv = restoreKept(del({ ...tableEntry('C', 'dal', 1, 'katori'), needs_review: true, server_version: 1 }), { id: 'C', code: 'forbidden' });
    expect(rv.deleted_at).toBeNull(); expect(counted(rv)).toBe(false);
    expect(keptNote('')).toBe(KEPT_COPY);
  });
});

// ---------- next-build edge (a) (rg10): a flagged row the server has, whose numbers the phone didn't know, counts the server's ----------
import { applyServerCopies } from '../src/lib/store';
import { needsServerCopy } from '../src/lib/domain';
describe('edge (a): an older-build row with a queued edit, flagged, counts the server’s numbers (fetched), not 0', () => {
  const older = (id: string) => { const o = { ...tableEntry(id, 'roti', 2, 'count', { slot: 'breakfast' }), server_version: 3 } as FoodEntry; delete (o as Partial<FoodEntry>).server_counts; return o; };
  const flagIt = async (id: string) => {
    for (let i = 0; i < 6 && !st.entries.find((x) => x.id === id)?.sync_error; i++) {
      const spy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + (i + 1) * 3_600_000);
      await act(async () => { await st.sync(); }); await tick(); spy.mockRestore();
    }
  };
  const serverTotal = () => Math.round([...server.rows.values()].reduce((a, x) => a + x.kcal, 0));
  test('queued edit (4 roti) then delete, 3x 5xx: phone == server (220) with the row flagged “(deleted)” and showing 220 kcal; retry deletes', async () => {
    const O = older('O'), k = Math.round(O.kcal.best);
    server.rows.set('O', { kcal: O.kcal.best, protein: O.protein_g.best, qty: 2, unit: 'count', version: 3 });
    server.patch5xx = true; server.del5xx.add('O');
    // the older build's queue still holds the 4-roti edit: nothing could be seeded (the phone's copy isn't the server's)
    await boot(<Today />, [{ ...O, ...tableEntry('O', 'roti', 4, 'count', { slot: 'breakfast' }), server_version: 3 }], [{ kind: 'upsert', entry: { ...O, ...tableEntry('O', 'roti', 4, 'count', { slot: 'breakfast' }), server_version: 3 }, tries: 0 }]);
    expect(st.entries.find((x) => x.id === 'O')!.server_counts).toBeUndefined();
    await act(async () => { st.deleteEntry('O'); }); await tick();
    await flagIt('O');
    const o = st.entries.find((x) => x.id === 'O')!;
    expect(o).toMatchObject({ delete_failed: true, sync_error: SERVER_ERROR, server_counts: { kcal: O.kcal.best, protein: O.protein_g.best } });
    expect(server.log.some((l) => l.method === 'GET' && l.path === '/v1/entries/O')).toBe(true);
    expect(counted(o)).toBe(true);
    expect(dayTotals(st.entries).kcal).toBe(serverTotal()); expect(serverTotal()).toBe(k); // 220, not 0 and not the 4-roti 440
    const txt = textOf(r);
    expect(txt).toContain(`${k} kcal`); expect(txt).not.toContain('not counted'); expect(txt).toContain('(deleted)'); expect(txt).toContain(NOT_DELETED_REASON);
    // the server comes back: tap-retry deletes it everywhere
    server.del5xx.clear();
    await act(async () => { st.retrySync('O'); }); await tick();
    expect(counted(st.entries.find((x) => x.id === 'O')!)).toBe(false); expect(server.rows.has('O')).toBe(false);
    expect(dayTotals(st.entries).kcal).toBe(0); expect(serverTotal()).toBe(0);
  });
  test('queued edit flagged by 3x 5xx on its PATCH: counts the server’s 220 (flagged), not 0 and not the unsaved 440', async () => {
    const O = older('P'), k = Math.round(O.kcal.best);
    server.rows.set('P', { kcal: O.kcal.best, qty: 2, unit: 'count', version: 3 });
    server.patch5xx = true;
    const ed = { ...O, ...tableEntry('P', 'roti', 4, 'count', { slot: 'breakfast' }), server_version: 3 };
    await boot(<Today />, [ed], [{ kind: 'upsert', entry: ed, tries: 0 }]);
    await flagIt('P');
    const p = st.entries.find((x) => x.id === 'P')!;
    expect(p).toMatchObject({ server_failed: true, sync_error: SERVER_ERROR, server_counts: { kcal: O.kcal.best } });
    expect(dayTotals(st.entries).kcal).toBe(k); expect(serverTotal()).toBe(k);
    expect(textOf(r)).toContain(`${k} kcal`); expect(textOf(r)).not.toContain('not counted'); expect(textOf(r)).toContain('Couldn’t sync this');
  });
  test('the GET fails too: still “not counted” (never a guess); the next app start asks again and counts the server’s copy', async () => {
    const O = older('Q'), k = Math.round(O.kcal.best);
    server.rows.set('Q', { kcal: O.kcal.best, qty: 2, unit: 'count', version: 3 });
    server.patch5xx = true; server.getDown = true;
    const ed = { ...O, ...tableEntry('Q', 'roti', 4, 'count', { slot: 'breakfast' }), server_version: 3 };
    await boot(<Today />, [ed], [{ kind: 'upsert', entry: ed, tries: 0 }]);
    await flagIt('Q');
    const q = st.entries.find((x) => x.id === 'Q')!;
    expect(q.server_failed).toBe(true); expect(q.server_counts).toBeUndefined(); expect(dayTotals(st.entries).kcal).toBe(0);
    expect(textOf(r)).toContain('not counted');
    // restart with the flagged row persisted: the GET goes through now
    const saved = JSON.parse(mockSaved!) as { entries: FoodEntry[]; queue: Op[] };
    await act(async () => { r.unmount(); });
    server.getDown = false;
    await boot(<Today />, saved.entries, saved.queue);
    expect(st.entries.find((x) => x.id === 'Q')!.server_counts).toEqual({ kcal: O.kcal.best, protein: 0 });
    expect(dayTotals(st.entries).kcal).toBe(k); expect(textOf(r)).toContain(`${k} kcal`); expect(textOf(r)).not.toContain('not counted');
  });
  test('a row the server never stored (no version) is not fetched and stays “not counted” (rg7 H1 unchanged)', async () => {
    server.patch5xx = true;
    const n = tableEntry('N', 'roti', 2, 'count');
    await boot(<Today />, [n], [{ kind: 'upsert', entry: n, tries: 0 }]);
    await flagIt('N');
    expect(st.entries.find((x) => x.id === 'N')!.server_failed).toBe(true);
    expect(server.log.some((l) => l.method === 'GET' && l.path.startsWith('/v1/entries/'))).toBe(false);
    expect(dayTotals(st.entries).kcal).toBe(0); expect(textOf(r)).toContain('not counted');
  });
  test('applyServerCopies (pure): copy -> server_counts (review = 0), flag kept; 404 on a flagged delete -> the delete won; others unchanged', () => {
    const flaggedDel = { ...older('A'), deleted_at: '2026-10-17T05:00:00Z', delete_failed: true, server_failed: true, sync_error: SERVER_ERROR } as FoodEntry;
    const flaggedSave = { ...older('B'), server_failed: true, sync_error: SERVER_ERROR } as FoodEntry;
    const fine = { ...older('C') } as FoodEntry;
    expect([flaggedDel, flaggedSave, fine].map(needsServerCopy)).toEqual([true, true, false]);
    const p = { entries: [flaggedDel, flaggedSave, fine], queue: [] as Op[] };
    const a = applyServerCopies(p, { A: { state: 'confirmed', kcal_best: 220, protein_best: 7 }, B: { state: 'needs_review', kcal_best: 0 }, C: { state: 'confirmed', kcal_best: 999 } });
    expect(a.entries[0]).toMatchObject({ delete_failed: true, server_counts: { kcal: 220, protein: 7 } }); expect(dayTotals(a.entries).kcal).toBe(220 + Math.round(fine.kcal.best));
    expect(a.entries[1]).toMatchObject({ server_failed: true, server_counts: { kcal: 0, protein: 0 } });
    expect(a.entries[2]).toBe(fine);
    const g = applyServerCopies({ entries: [flaggedDel], queue: [{ kind: 'delete', id: 'A', tries: 0 }] as Op[] }, { A: null });
    expect(g.entries[0].delete_failed).toBeUndefined(); expect(g.entries[0].sync_error).toBeUndefined(); expect(counted(g.entries[0])).toBe(false); expect(g.queue).toHaveLength(0);
    // 404 on a flagged SAVE: left for the retry's own 404 (deleted elsewhere) flow
    expect(applyServerCopies({ entries: [flaggedSave], queue: [] as Op[] }, { B: null }).entries[0]).toBe(flaggedSave);
    expect(applyServerCopies(p, {})).toBe(p);
  });
});

// ---------- next-build (rg10 note 1): an edit still unsynced when a delete is refused is never dropped silently ----------
import { editKept, editNotSaved } from '../src/lib/store';
describe('dropped edit: a refused delete re-sends the edit it had replaced (or shows the server’s copy and says the edit wasn’t saved)', () => {
  const F = () => ({ ...tableEntry('F', 'roti', 2, 'count', { slot: 'breakfast' }), server_version: 1, server_counts: { kcal: 220, protein: 7 } });
  const LOCKED = { error: { code: 'forbidden', message: 'This entry is locked.' } };
  const serverTotal = () => Math.round([...server.rows.values()].reduce((a, x) => a + x.kcal, 0));
  const later = async (h = 1) => { const spy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + h * 3_600_000); await act(async () => { await st.sync(); }); await tick(); spy.mockRestore(); };
  const edit3 = async () => { await act(async () => { st.updateEntry({ ...st.entries.find((x) => x.id === 'F')!, ...tableEntry('F', 'roti', 3, 'count', { slot: 'breakfast' }), server_version: 1 }); }); await tick(); };
  test('queued edit (PATCH 5xx) then delete refused 403: the edit is re-sent; the row shows 3 pieces and says so; once the PATCH lands phone == server (330)', async () => {
    const f = F(); server.rows.set('F', { kcal: 220, protein: 7, qty: 2, unit: 'count', version: 1 });
    server.patch5xx = true;
    await boot(<Today />, [f]);
    await edit3();
    expect(st.queue.some((o) => o.kind === 'upsert')).toBe(true); // the edit is waiting (5xx backoff)
    server.delAnswer.set('F', [{ status: 403, body: LOCKED }]);
    await act(async () => { st.deleteEntry('F'); }); await tick();
    expect(server.log.some((l) => l.method === 'GET' && l.path === '/v1/entries/F')).toBe(true); // the server's copy was read
    const row = st.entries.find((x) => x.id === 'F')!;
    expect(row).toMatchObject({ deleted_at: null, qty: 3, unit: 'count', kept_on_server: true, server_counts: { kcal: 220, protein: 7 } });
    expect(row.unsynced_edit).toBeUndefined(); expect(row.server_failed).toBeUndefined();
    expect(row.server_note).toBe(`${KEPT_COPY} This entry is locked. ${editKept('3 pieces')}`);
    expect(st.queue.filter((o) => o.kind === 'upsert' && o.entry.id === 'F')).toHaveLength(1); // re-queued, not dropped
    expect(st.queue.some((o) => o.kind === 'delete')).toBe(false);
    expect(textOf(r)).toContain(editKept('3 pieces'));
    // the server is back: the edit lands and everything agrees
    server.patch5xx = false; await later();
    expect(st.queue).toHaveLength(0);
    const k3 = Math.round(tableEntry('F', 'roti', 3, 'count').kcal.best);
    expect(server.rows.get('F')!.kcal).toBe(k3); // the 3-piece edit reached the server
    expect(dayTotals(st.entries).kcal).toBe(serverTotal()); expect(serverTotal()).toBe(k3);
    expect(r.root.find((n) => n.props.testID === 'server-note-kcal' && typeof n.type !== 'string').props.children).toBe(`${k3} kcal`);
  });
  test('the re-sent edit still 5xx-es 3 times: flagged and counted at the server’s 220 (shown 220), never the unsaved 330', async () => {
    const f = F(); server.rows.set('F', { kcal: 220, protein: 7, qty: 2, unit: 'count', version: 1 });
    server.patch5xx = true;
    await boot(<Today />, [f]);
    await edit3();
    server.delAnswer.set('F', [{ status: 403, body: LOCKED }]);
    await act(async () => { st.deleteEntry('F'); }); await tick();
    for (let i = 0; i < 6 && !st.entries.find((x) => x.id === 'F')!.server_failed; i++) await later(i + 1);
    const row = st.entries.find((x) => x.id === 'F')!;
    expect(row).toMatchObject({ server_failed: true, sync_error: SERVER_ERROR });
    expect(dayTotals(st.entries).kcal).toBe(220); expect(serverTotal()).toBe(220);
  });
  test('409 with a newer server copy (another device: 4 pieces): the server’s copy wins (shown == counted 440) and the note says the 3-piece edit wasn’t saved', async () => {
    const copy = { version: 5, state: 'confirmed', dish_id: 'roti', qty: 4, unit: 'count', kcal_best: 440, protein_best: 14 };
    server.rows.set('F', { kcal: 440, qty: 4, unit: 'count', version: 5 });
    server.patch5xx = true;
    await boot(<Today />, [F()]);
    await edit3();
    server.delAnswer.set('F', [{ status: 409, body: { error: { code: 'version_conflict' }, entry: copy } }, { status: 409, body: { error: { code: 'version_conflict' }, entry: copy } }]);
    await act(async () => { st.deleteEntry('F'); }); await tick();
    const row = st.entries.find((x) => x.id === 'F')!;
    expect(row).toMatchObject({ deleted_at: null, qty: 4, unit: 'count', server_version: 5, server_counts: { kcal: 440, protein: 14 } });
    expect(row.kcal.best).toBe(440); expect(row.server_failed).toBeUndefined();
    expect(row.server_note).toBe(`${KEPT_COPY} ${editNotSaved('3 pieces')}`);
    expect(st.queue).toHaveLength(0);
    expect(dayTotals(st.entries).kcal).toBe(440); expect(serverTotal()).toBe(440);
    expect(textOf(r)).toContain('Your change to 3 pieces wasn’t saved.');
  });
  test('no queued edit: a refused delete reads no copy and changes nothing else (rg10 behaviour unchanged)', async () => {
    server.rows.set('F', { kcal: 220, qty: 2, unit: 'count', version: 1 });
    server.delAnswer.set('F', [{ status: 403, body: LOCKED }]);
    await boot(<Today />, [F()]);
    await act(async () => { st.deleteEntry('F'); }); await tick();
    expect(server.log.some((l) => l.method === 'GET' && l.path === '/v1/entries/F')).toBe(false);
    const row = st.entries.find((x) => x.id === 'F')!;
    expect(row.server_note).toBe(`${KEPT_COPY} This entry is locked.`); expect(row.qty).toBe(2); expect(st.queue).toHaveLength(0);
  });
  test('a 5xx-flagged edit, then a delete refused on its retry: the edit is re-sent (the flag set unsynced_edit)', async () => {
    server.rows.set('F', { kcal: 220, protein: 7, qty: 2, unit: 'count', version: 1 });
    server.patch5xx = true;
    await boot(<Today />, [F()]);
    await edit3();
    for (let i = 0; i < 6 && !st.entries.find((x) => x.id === 'F')!.server_failed; i++) await later(i + 1);
    expect(st.entries.find((x) => x.id === 'F')!.server_failed).toBe(true); expect(st.queue).toHaveLength(0);
    server.delAnswer.set('F', [{ status: 422, body: LOCKED }]);
    await act(async () => { st.deleteEntry('F'); }); await tick();
    const row = st.entries.find((x) => x.id === 'F')!;
    expect(row).toMatchObject({ deleted_at: null, qty: 3 }); expect(row.server_note).toContain(editKept('3 pieces'));
    server.patch5xx = false; await later(10);
    expect(dayTotals(st.entries).kcal).toBe(serverTotal()); expect(serverTotal()).toBe(Math.round(tableEntry('F', 'roti', 3, 'count').kcal.best));
  });
  test('restoreKept (pure): edited + same-version copy -> re-send; newer copy -> server’s copy + note; no copy and unsavable -> flagged at server_counts + note', () => {
    const del = (e: FoodEntry) => ({ ...e, deleted_at: '2026-10-17T05:00:00Z', unsynced_edit: true });
    const e3 = { ...tableEntry('A', 'roti', 3, 'count'), server_version: 2, server_counts: { kcal: 220, protein: 7 } } as FoodEntry;
    const out: { requeue?: boolean } = {};
    const a = restoreKept(del(e3), { id: 'A', code: 'forbidden', edited: true, row: { version: 2, state: 'confirmed', qty: 2, unit: 'count', kcal_best: 220, protein_best: 7 } }, out);
    expect(out.requeue).toBe(true); expect(a).toMatchObject({ qty: 3, deleted_at: null, server_counts: { kcal: 220, protein: 7 } }); expect(a.unsynced_edit).toBeUndefined();
    const out2: { requeue?: boolean } = {};
    const b = restoreKept(del(e3), { id: 'A', code: 'forbidden', edited: true, row: { version: 3, state: 'confirmed', qty: 1, unit: 'count', kcal_best: 110, protein_best: 3 } }, out2);
    expect(out2.requeue).toBeUndefined(); expect(b).toMatchObject({ qty: 1, server_version: 3, server_counts: { kcal: 110, protein: 3 } }); expect(b.kcal.best).toBe(110);
    expect(dayTotals([b]).kcal).toBe(110); expect(b.server_note).toBe(`${KEPT_COPY} ${editNotSaved('3 pieces')}`);
    // a custom row whose edit can't be saved (0 kcal) and no copy: counted as the server last had it, flagged, named in the note
    const c0 = { ...e3, id: 'C', dish_id: null, custom_name: 'thali', source: 'custom', kcal: { low: 0, best: 0, high: 0 } } as FoodEntry;
    const out3: { requeue?: boolean } = {};
    const c = restoreKept(del(c0), { id: 'C', code: 'forbidden', edited: true }, out3);
    expect(out3.requeue).toBeUndefined(); expect(c.server_failed).toBe(true); expect(dayTotals([c]).kcal).toBe(220); expect(c.server_note).toBe(`${KEPT_COPY} ${editNotSaved('0 kcal')}`);
  });
});
