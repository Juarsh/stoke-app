/** @jest-environment node */
// rg7 import path, store level against a REAL backend (IMPORT_URL + IMPORT_ADMIN, AUTH_MODE=dev; skipped without them).
// Tester's repro: import zarda_pulao at a new table version, then on a phone with the bundled (older) table:
//  B1 before the pull: the server's parse answer for "1 plate zarda" is a dish (not "Couldn’t estimate this"); the row is
//     held ('Check amount'), not counted on either side; the response header says the server's table is newer;
//  B3 after the pull: the save carries the pulled version (and an older phone's stale version is accepted too);
//  B2 a variant_required answer (zarda is in a variant group) reopens with the server's types; a pick saves;
//  every unit: the pulled list decides (refused up front with the dish's name, or saved); phone == server == summary.
// Run: IMPORT_URL=http://localhost:8473 IMPORT_ADMIN=<admin token> npx jest __tests__/importPath.live.test.ts
const URL = process.env.IMPORT_URL ?? '';
const ADMIN = process.env.IMPORT_ADMIN ?? '';
jest.mock('expo-constants', () => ({ expoConfig: { extra: { apiUrl: process.env.IMPORT_URL ?? '' } } }));
import { createApi } from '../src/lib/api';
import { counted, entryFromItem, entryRefusal, notMeasured, reopenRejected, type FoodEntry } from '../src/lib/domain';
import { aiStatus } from '../src/lib/aiRows';
import { pickVariant, reviewRowKind, variantOptions } from '../src/lib/confirmBatch';
import { flush, type Op } from '../src/lib/syncQueue';
import { applyFlush } from '../src/lib/store';
import { holdForUnits, needsUnits } from '../src/lib/serverRow';
import { DISH_TABLE_VERSION, parser, UNITS, type Item } from '../src/parser';

jest.setTimeout(5 * 60_000);
const nodeHttp = require('http');
const agent = new nodeHttp.Agent({ keepAlive: true, maxSockets: 8 });
(globalThis as { fetch: unknown }).fetch = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
  new Promise((resolve, reject) => {
    const rq = nodeHttp.request(url, { method: init.method ?? 'GET', headers: init.headers, agent }, (res: { statusCode: number; headers: Record<string, string>; on: (e: string, f: (x?: Buffer) => void) => void }) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c!));
      res.on('end', () => { const t = Buffer.concat(chunks).toString(); const st = res.statusCode;
        resolve({ ok: st >= 200 && st < 300, status: st, headers: { get: (k: string) => res.headers[k.toLowerCase()] ?? null }, text: async () => t, json: async () => JSON.parse(t) }); });
    });
    rq.on('error', reject);
    if (init.body) rq.write(init.body);
    rq.end();
  });
const DAY = '2026-10-17';
const run = Date.now().toString(36);
const DISH = 'zarda_pulao';
const raw = async (method: string, path: string, auth: string, body?: unknown) => {
  const r = await fetch(URL + path, { method, headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) } as never) as unknown as { status: number; json: () => Promise<any> };
  return { status: r.status, body: await r.json().catch(() => null) };
};
const sent: { path: string; body: any }[] = [];
async function sync(user: string, entries: FoodEntry[], op: Op) {
  const api = createApi(() => `dev:${user}`);
  const sender = { upsertEntry: api.upsertEntry, deleteEntry: api.deleteEntry, deleteRemembered: api.deleteRemembered, resolvePending: async () => null };
  const queue = [op];
  const r = await flush(queue, sender);
  const out = applyFlush({ entries, queue }, queue, r);
  // a refused new row goes back to Review (the store re-queues it as needs_review)
  return { entries: out.entries, requeued: out.queue };
}
/** what store.addEntries / updateEntry do: hold a dish with no units, refuse what the guard refuses, else queue + flush */
async function save(user: string, entries: FoodEntry[], e0: FoodEntry): Promise<{ entries: FoodEntry[]; refused?: string }> {
  const e = needsUnits(e0) ? holdForUnits(e0) : e0;
  const why = entryRefusal(e);
  if (why) return { entries, refused: why };
  let r = await sync(user, [...entries.filter((x) => x.id !== e.id), e], { kind: 'upsert', entry: e, tries: 0 });
  for (const op of r.requeued) r = await sync(user, r.entries, op); // the review copy reaches the server too
  return { entries: r.entries };
}
async function compare(user: string, entries: FoodEntry[], what: string, bad: string[]) {
  const list = (await raw('GET', `/v1/entries?date=${DAY}`, `dev:${user}`)).body;
  const sum = (await raw('GET', `/v1/summary?date=${DAY}`, `dev:${user}`)).body;
  const phone = entries.filter(counted).reduce((s, x) => s + x.kcal.best, 0);
  const server = list.total?.kcal ?? 0, summary = sum.kcal_in ?? 0;
  if (Math.abs(phone - server) > 0.5 || Math.abs(server - summary) > 0.5) bad.push(`${what}: phone ${phone} server ${server} summary ${summary}`);
  for (const p of entries.filter(counted)) {
    const s = (list.entries ?? []).find((x: { client_id?: string }) => x.client_id === p.id);
    if (!s || s.state === 'needs_review' || s.qty !== p.qty || s.unit !== p.unit) bad.push(`${what}: row ${JSON.stringify(s && { state: s.state, qty: s.qty, unit: s.unit })} phone ${p.qty} ${p.unit}`);
  }
}


(URL && ADMIN ? describe : describe.skip)('rg7 import path: zarda_pulao at a new server table', () => {
  afterAll(() => parser.setPulledUnits(null));
  test('before pull, after pull, old-version phone', async () => {
    parser.setPulledUnits(null);
    const imp = await raw('POST', '/admin/dishes/import', ADMIN, { note: 'rg7 import path', items: [{ id: DISH, name: 'zarda pulao', aliases: ['zarda', 'meetha chawal'], unit: 'katori', portion_grams: 150,
      kcal: 390, kcal_low: 320, kcal_high: 470, protein_g: 5, protein_low: 4, protein_high: 6.5, carbs_g: 72, fat_g: 9, diet: 'veg', category: 'main',
      source: 'ifct2017', source_note: 'IFCT 2017 rice + sugar + ghee recipe calc' }] });
    expect([200, 201]).toContain(imp.status);
    const version = imp.body.dish_table_version as number;
    expect(version).toBeGreaterThan(DISH_TABLE_VERSION);
    expect(parser.dishById(DISH)).toBeUndefined();
    const bad: string[] = []; const out: Record<string, unknown> = { version };
    // B1: parse answers with the server's dish; the header says the table is newer
    const u0 = `ip0${run}`;
    let seen = 0;
    const api0 = createApi(() => `dev:${u0}`, undefined, (v) => { seen = v; });
    const pr = await api0.parse('1 plate zarda', false);
    const it0 = pr.items.find((x) => x.dish_id === DISH);
    out.parse = { items: pr.items.map((x) => x.dish_id), ai_state: (pr as { ai_state?: string }).ai_state, fallback: pr.fallback, status: aiStatus(pr) };
    expect(it0).toBeDefined();
    expect(aiStatus(pr)).toBe('ready'); // never the failed row ("Couldn’t estimate this")
    expect(seen).toBe(version);
    const entry = (id: string, it: Item, unit = it.unit, qty = it.quantity) => entryFromItem({ ...it, unit, quantity: qty, needs_confirmation: false },
      { id, slot: 'lunch', raw_text: `${qty} ${unit} zarda`, local_date: DAY, tableVersion: DISH_TABLE_VERSION });
    const h = await save(u0, [], entry(`h-${run}`, it0!));
    expect(h.entries.find((x) => x.id === `h-${run}`)).toMatchObject({ needs_review: true, reject_code: 'units_unknown', server_note: 'Check amount' });
    await compare(u0, h.entries, 'held', bad);
    // pull
    const t = await api0.getDishUnits();
    expect(t?.version).toBe(version);
    parser.setPulledUnits(t!.units, t!.version, t!.names);
    const units = parser.supportedUnits(DISH);
    out.units = units;
    expect(units.length).toBeGreaterThan(0);
    expect(notMeasured(DISH, 'piece')).toBe('zarda pulao isn’t measured in pieces');
    // B3 + B2: the save carries the pulled version; a type pick if the server asks for one
    const u1 = `ip1${run}`;
    const fetch0 = globalThis.fetch as (u: string, i: { body?: string }) => Promise<unknown>;
    (globalThis as { fetch: unknown }).fetch = (u: string, i: { body?: string } = {}) => { if (i.body) sent.push({ path: u, body: JSON.parse(i.body) }); return fetch0(u, i); };
    let r = await save(u1, [], entry(`z-${run}`, it0!));
    const post = sent.find((s) => (s.body.items ?? [])[0]?.client_id === `z-${run}`);
    expect(post?.body.items[0].dish_table_version).toBe(version);
    let z = r.entries.find((x) => x.id === `z-${run}`)!;
    out.firstSave = z.reject_code ?? (counted(z) ? 'counted' : 'review');
    if (z.reject_code === 'variant_required') {
      expect(reviewRowKind(z.review_item!)).toBe('chips');
      const opts = variantOptions(z.review_item!);
      out.variantOptions = opts.map((o) => o.dish_id);
      const mine = opts.find((o) => o.dish_id === DISH)!;
      expect(mine).toBeDefined();
      const picked = pickVariant(z.review_item!, mine);
      const e2 = { ...entryFromItem({ ...picked, needs_confirmation: false }, { id: z.id, slot: 'lunch', raw_text: z.raw_text, local_date: DAY, tableVersion: DISH_TABLE_VERSION }), server_version: z.server_version };
      r = await save(u1, r.entries, e2);
      z = r.entries.find((x) => x.id === `z-${run}`)!;
    }
    expect(counted(z)).toBe(true);
    await compare(u1, r.entries, 'saved', bad);
    // old-version phone: an older build sends its stale table version for the new dish: saved, never "unknown dish_id"
    const stale = await raw('POST', '/v1/entries', `dev:ip2${run}`, { local_date: DAY, items: [{ dish_id: DISH, qty: 1, unit: 'katori', source: 'table', confirmed: true, dish_table_version: DISH_TABLE_VERSION, variant_dish_id: DISH }] });
    out.staleVersion = stale.status;
    expect(stale.status).toBe(201);
    // every unit, as a new row: the pulled list decides; phone == server == summary
    const per: Record<string, string> = {};
    for (const [i, u] of UNITS.entries()) {
      const user = `ipu${i}${run}`, id = `u-${run}-${i}`;
      const e = { ...entry(id, it0!, u, 1), variant_dish_id: DISH };
      const s = await save(user, [], e);
      const row = s.entries.find((x) => x.id === id);
      per[u] = s.refused ? `refused: ${s.refused}` : row && counted(row) ? `counted ${row.kcal.best}` : `review: ${row?.server_note ?? row?.reject_code}`;
      if (units.includes(u) === !!s.refused) bad.push(`${u}: pulled ${units} refused=${s.refused}`);
      await compare(user, s.entries, u, bad);
    }
    out.units_cases = per; out.mismatches = bad;
    console.log(JSON.stringify(out, null, 1));
    require('fs').writeFileSync(process.env.IMPORT_OUT ?? '/tmp/import-path.json', JSON.stringify(out, null, 1));
    expect(bad).toEqual([]);
    void reopenRejected;
  });
});
