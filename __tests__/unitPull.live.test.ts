/** @jest-environment node */
// PE (rg6 follow-up), store level against a REAL backend (PULL_URL + PULL_ADMIN, AUTH_MODE=dev; skipped without them):
// import ONE new dish the phone has never seen, then
//  1. before the pull the phone has no units for it: the row is held for review ("Check amount"), not counted, and the
//     server keeps it needs_review (not counted either);
//  2. pull the units with the dish table (GET /v1/dishes supported_units, same table version) into the phone's store;
//  3. save the dish in each of the 7 units (new row POST and an edit PATCH): guard, flush, applyFlush.
// After every case: phone counted kcal == server /v1/entries total == /v1/summary kcal_in, counted rows match the server.
// Run: PULL_URL=http://localhost:8472 PULL_ADMIN=<admin token> npx jest __tests__/unitPull.live.test.ts
const URL = process.env.PULL_URL ?? '';
const ADMIN = process.env.PULL_ADMIN ?? '';
jest.mock('expo-constants', () => ({ expoConfig: { extra: { apiUrl: process.env.PULL_URL ?? '' } } }));
import { createApi } from '../src/lib/api';
import { counted, entryFromItem, entryRefusal, type FoodEntry } from '../src/lib/domain';
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
const DISH = `kodo_khichdi_${run}`;
const raw = async (method: string, path: string, auth: string, body?: unknown) => {
  const r = await fetch(URL + path, { method, headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) } as never) as unknown as { status: number; json: () => Promise<any> };
  return { status: r.status, body: await r.json().catch(() => null) };
};
async function sync(user: string, entries: FoodEntry[], op: Op) {
  const api = createApi(() => `dev:${user}`);
  const sender = { upsertEntry: api.upsertEntry, deleteEntry: api.deleteEntry, deleteRemembered: api.deleteRemembered, resolvePending: async () => null };
  const queue = [op];
  const r = await flush(queue, sender);
  return applyFlush({ entries, queue }, queue, r).entries;
}
/** what store.addEntries / updateEntry do: hold a dish with no units, refuse what the guard refuses, else queue + flush */
async function save(user: string, entries: FoodEntry[], e0: FoodEntry): Promise<{ entries: FoodEntry[]; refused?: string }> {
  const e = needsUnits(e0) ? holdForUnits(e0) : e0;
  const why = entryRefusal(e);
  if (why) return { entries, refused: why };
  return { entries: await sync(user, [...entries.filter((x) => x.id !== e.id), e], { kind: 'upsert', entry: e, tries: 0 }) };
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

(URL && ADMIN ? describe : describe.skip)('PE: import a new dish, pull its units, save it in each unit: phone == server', () => {
  afterAll(() => parser.setPulledUnits(null));
  test('pull + every unit', async () => {
    const imp = await raw('POST', '/admin/dishes/import', ADMIN, { note: 'rg6 units pull test', items: [{ id: DISH, name: `kodo khichdi ${run}`, aliases: [], unit: 'katori', portion_grams: 180,
      kcal: 210, kcal_low: 170, kcal_high: 260, protein_g: 6, protein_low: 4.5, protein_high: 7.5, carbs_g: 34, fat_g: 5, diet: 'veg', category: 'main',
      source: 'usda_fdc', source_note: 'Checked against IFCT 2017 kodo millet + moong dal recipe calc' }] });
    expect(imp.status).toBe(201);
    const version = imp.body.dish_table_version as number;
    expect(parser.dishById(DISH)).toBeUndefined(); // new to the phone
    expect(parser.unitsFor(DISH)).toBeNull();
    // the phone's reading of the new dish (no local row: numbers as the server's item would give them)
    const item = (unit: string, qty = 1): Item => ({ ...parser.unknown(DISH), dish_id: DISH, name: `kodo khichdi ${run}`, source: 'table', data_source: 'table', ai_estimate: false,
      quantity: qty, unit, kcal: { low: 170 * qty, best: 210 * qty, high: 260 * qty }, protein_g: { low: 4.5 * qty, best: 6 * qty, high: 7.5 * qty }, carbs_g: 34 * qty, fat_g: 5 * qty, needs_confirmation: false } as Item);
    const entry = (id: string, unit: string, qty = 1) => entryFromItem(item(unit, qty), { id, slot: 'lunch', raw_text: `${qty} ${unit} kodo khichdi`, local_date: DAY, tableVersion: version });
    const bad: string[] = [];
    // 1. before the pull: held, not counted anywhere
    const u0 = `pu0${run}`;
    const h = await save(u0, [], entry(`h-${run}`, 'katori'));
    const held = h.entries.find((x) => x.id === `h-${run}`)!;
    expect(held).toMatchObject({ needs_review: true, reject_code: 'units_unknown', server_note: 'Check amount' });
    await compare(u0, h.entries, 'held', bad);
    // 2. pull
    const t = await createApi(() => `dev:${u0}`).getDishUnits();
    expect(t?.version).toBe(version);
    const units = t!.units[DISH];
    expect(units?.length).toBeGreaterThan(0);
    expect(units).not.toEqual(UNITS); // the server's list, not all 7
    parser.setPulledUnits(t!.units);
    expect(parser.supportedUnits(DISH)).toEqual(units);
    // 3. each unit, POST and PATCH
    const out: Record<string, string> = {};
    for (const [i, u] of UNITS.entries()) {
      for (const mode of ['POST', 'PATCH'] as const) {
        const user = `pu${i}${mode}${run}`, id = `p-${run}-${i}-${mode}`;
        let es: FoodEntry[] = [];
        if (mode === 'PATCH') es = (await save(user, es, entry(id, 'katori'))).entries;
        const base = mode === 'PATCH' ? es.find((x) => x.id === id)! : entry(id, u);
        const next = mode === 'PATCH' ? { ...base, unit: u, updated_at: new Date(Date.now() + 1000).toISOString() } : base;
        const r = await save(user, es, next);
        const row = r.entries.find((x) => x.id === id);
        out[`${u} ${mode}`] = r.refused ? `refused: ${r.refused}` : row && counted(row) ? `counted ${row.kcal.best}` : `review: ${row?.server_note}`;
        if (units.includes(u) === !!r.refused) bad.push(`${u} ${mode}: pulled units ${units} but refused=${r.refused}`);
        await compare(user, r.entries, `${u} ${mode}`, bad);
      }
    }
    console.log(JSON.stringify({ dish: DISH, version, units, cases: out, mismatches: bad }, null, 1));
    require('fs').writeFileSync(process.env.PULL_OUT ?? '/tmp/unit-pull.json', JSON.stringify({ dish: DISH, version, units, cases: out, mismatches: bad }, null, 1));
    expect(bad).toEqual([]);
    void DISH_TABLE_VERSION;
  });
});
