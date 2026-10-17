/** @jest-environment node */
// Tester rg6 F1 sweep, store level, against a REAL backend (SWEEP_URL, AUTH_MODE=dev; skipped without it):
// every table dish x every unit chip (and two old-queue inputs: unit 'litre', qty 0), as a NEW row (POST) and as an EDIT of a
// synced row (PATCH). Each case runs what the store does: the guard (entryRefusal), then flush + applyFlush. After sync the
// phone's counted kcal must equal the server's day total and /v1/summary, and a counted row must have the server's qty / unit.
// A difference the phone flags on the row (sync error with the server's reason) is not silent and is not counted as a mismatch.
// Run: SWEEP_URL=http://localhost:8471 npx jest __tests__/unitSweep.live.test.ts
const URL = process.env.SWEEP_URL ?? '';
jest.mock('expo-constants', () => ({ expoConfig: { extra: { apiUrl: process.env.SWEEP_URL ?? '' } } }));
import { createApi } from '../src/lib/api';
import { counted, entryFromItem, entryRefusal, type FoodEntry } from '../src/lib/domain';
import { flush, type Op } from '../src/lib/syncQueue';
import { applyFlush } from '../src/lib/store';
import { DISHES, DISH_TABLE_VERSION, parser, UNITS } from '../src/parser';

jest.setTimeout(30 * 60_000);
// plain node http (the jest-expo fetch polyfill can't read bodies here)
const nodeHttp = require('http');
const agent = new nodeHttp.Agent({ keepAlive: true, maxSockets: 16 });
(globalThis as { fetch: unknown }).fetch = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
  new Promise((resolve, reject) => {
    const rq = nodeHttp.request(url, { method: init.method ?? 'GET', headers: init.headers, agent }, (res: { statusCode: number; on: (e: string, f: (x?: Buffer) => void) => void }) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c!));
      res.on('end', () => { const t = Buffer.concat(chunks).toString(); const st = res.statusCode;
        resolve({ ok: st >= 200 && st < 300, status: st, text: async () => t, json: async () => JSON.parse(t) }); });
    });
    rq.on('error', reject);
    if (init.body) rq.write(init.body);
    rq.end();
  });
const DAY = '2026-10-17';
const run = Date.now().toString(36);
type Case = { dish: string; unit: string; qty: number; mode: 'POST' | 'PATCH'; old?: boolean };
type Bad = Case & { phone: number; server: number; summary: number; why: string };

async function http(user: string, path: string) {
  const r = await fetch(URL + path, { headers: { Authorization: `Bearer dev:${user}` } });
  return r.json();
}
function baseEntry(d: (typeof DISHES)[number], id: string): FoodEntry {
  const it = parser.recompute(d.id, 1, '', d.oil_sensitive ? 'normal' : '');
  const e = entryFromItem({ ...it, needs_confirmation: false }, { id, slot: 'lunch', raw_text: d.name, local_date: DAY, tableVersion: DISH_TABLE_VERSION });
  return { ...e, variant_dish_id: d.id }; // a variant-group dish: the user picked this one
}
function edited(e: FoodEntry, unit: string, qty: number): FoodEntry {
  let n: FoodEntry = { ...e, unit, qty, updated_at: new Date(Date.now() + 1000).toISOString() };
  try {
    const it = parser.recompute(e.dish_id!, qty, unit, e.oil_level);
    n = { ...n, kcal: { ...it.kcal }, protein_g: { ...it.protein_g }, carbs_g: it.carbs_g, fat_g: it.fat_g, qty: it.quantity, unit: it.unit };
  } catch { /* an input the recompute refuses (old queue): sent as it is */ }
  return n;
}
async function sync(user: string, entries: FoodEntry[], op: Op) {
  const api = createApi(() => `dev:${user}`);
  const sender = { upsertEntry: api.upsertEntry, deleteEntry: api.deleteEntry, deleteRemembered: api.deleteRemembered, resolvePending: async () => null };
  const queue = [op];
  const r = await flush(queue, sender);
  return applyFlush({ entries, queue }, queue, r).entries;
}
/** the store: the guard refuses up front (nothing sent, nothing counted), else the op is queued and flushed */
async function save(user: string, entries: FoodEntry[], e: FoodEntry, guard: boolean) {
  if (guard && entryRefusal(e)) return entries;
  return sync(user, [...entries.filter((x) => x.id !== e.id), e], { kind: 'upsert', entry: e, tries: 0 });
}

(URL ? describe : describe.skip)('rg6 F1 sweep: phone == server == summary for every dish x unit', () => {
  test('sweep', async () => {
    const cases: Case[] = [];
    for (const d of DISHES) for (const mode of ['POST', 'PATCH'] as const) {
      for (const u of UNITS) cases.push({ dish: d.id, unit: u, qty: 1, mode });
      // the same unsupported unit queued by an older build (no guard): the server's needs_review must reach the row
      for (const u of UNITS) if (!parser.unitSupported(d.id, u)) cases.push({ dish: d.id, unit: u, qty: 1, mode, old: true });
      cases.push({ dish: d.id, unit: 'litre', qty: 1, mode }, { dish: d.id, unit: d.unit, qty: 0, mode });
    }
    const bad: Bad[] = []; const flaggedCases: (Case & { why: string; reason?: string })[] = [];
    let n = 0, refused = 0, review = 0, flagged = 0, silentReview = 0;
    const work = async (c: Case, i: number) => {
      const d = DISHES.find((x) => x.id === c.dish)!;
      const user = `sw${run}${i}`, id = `sw-${run}-${i}`;
      // old-queue inputs ('litre', qty 0) skip the guard: an op queued by an older build is flushed as it is
      const guard = !c.old && c.unit !== 'litre' && c.qty !== 0;
      let entries: FoodEntry[] = [];
      const base = baseEntry(d, id);
      if (c.mode === 'PATCH') {
        entries = await save(user, entries, base, true);
        if (!entries.some((x) => x.id === id && counted(x))) return; // base not saved as a counted row: nothing to edit
      }
      const next = edited(c.mode === 'PATCH' ? entries.find((x) => x.id === id)! : base, c.unit, c.qty);
      if (guard && entryRefusal(next)) refused++;
      entries = await save(user, entries, next, guard);
      const phoneRows = entries.filter(counted);
      const phone = phoneRows.reduce((s, x) => s + x.kcal.best, 0);
      if (entries.some((x) => x.needs_review)) review++;
      // a row the server keeps for review must be visibly flagged on the phone (Review row with the server's note)
      if (entries.some((x) => x.needs_review && !x.server_note && !x.reject_code)) silentReview++;
      const list = await http(user, `/v1/entries?date=${DAY}`);
      const sum = await http(user, `/v1/summary?date=${DAY}`);
      const server = list.total?.kcal ?? 0, summary = sum.kcal_in ?? 0;
      let why = '';
      if (Math.abs(phone - server) > 0.5 || Math.abs(server - summary) > 0.5) why = 'kcal';
      for (const p of phoneRows) {
        const s = (list.entries ?? []).find((x: { client_id?: string }) => x.client_id === p.id);
        if (!s || s.state === 'needs_review' || Math.abs(s.qty - p.qty) > 1e-9 || s.unit !== p.unit) why ||= `row ${JSON.stringify(s && { state: s.state, qty: s.qty, unit: s.unit })} phone ${p.qty} ${p.unit}`;
      }
      // the phone flags it on the row (sync error + the server's reason): not silent
      if (why && entries.some((x) => x.sync_error && x.sync_reason)) { flagged++; flaggedCases.push({ ...c, why, reason: entries.find((x) => x.sync_reason)?.sync_reason }); why = ''; }
      if (why) bad.push({ ...c, phone, server, summary, why });
      n++;
    };
    const POOL = 12;
    for (let i = 0; i < cases.length; i += POOL) await Promise.all(cases.slice(i, i + POOL).map((c, k) => work(c, i + k)));
    const by = (m: string) => bad.filter((b) => b.mode === m).length;
    const out = { cases: cases.length, ran: n, guardRefused: refused, endedInReview: review, flaggedWithReason: flagged, reviewWithoutNote: silentReview, mismatches: bad.length, post: by('POST'), patch: by('PATCH') };
    console.log(JSON.stringify({ ...out, sample: bad.slice(0, 12) }, null, 1));
    require('fs').writeFileSync(process.env.SWEEP_OUT ?? '/tmp/unit-sweep.json', JSON.stringify({ ...out, bad, flaggedCases }, null, 1));
    expect(bad).toEqual([]); expect(silentReview).toBe(0);
  });
});
