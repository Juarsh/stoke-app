/** @jest-environment node */
// rg8 B2, against a REAL backend (TYPED_URL, AUTH_MODE=dev; skipped without it): typed "1 {unit} {dish}" for every dish ×
// every unit it supports. Two paths:
//  local  - the phone's own parse of the text (dishes it has): the reading is 1 {unit}, or it isn't counted;
//  server - the phone doesn't know the dish (newly imported): the span goes to /v1/parse WITH its amount words (the real
//           amount extraction builds it) and a table answer whose amount differs from the phone's reading is flagged.
// A mismatch = a counted reading whose qty/unit isn't what was typed (silent). Also counted: server answers that differ.
// Run: TYPED_URL=http://localhost:8471 npx jest __tests__/typedUnits.live.test.ts
const URL = process.env.TYPED_URL ?? '';
jest.mock('expo-constants', () => ({ expoConfig: { extra: { apiUrl: process.env.TYPED_URL ?? '' } } }));
import { parseLocal } from '../src/lib/parseLocal';
import { kindOf } from '../src/lib/confirmBatch';
import { flagAmount, sentText } from '../src/lib/spanAmount';
import { isPlaceholder } from '../src/lib/itemKind';
import { parser, type Item } from '../src/parser';
import rules from '../src/data/rules.json';

jest.setTimeout(30 * 60_000);
const nodeHttp = require('http');
const agent = new nodeHttp.Agent({ keepAlive: true, maxSockets: 16 });
const fives: string[] = [];
function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const b = JSON.stringify(body);
    const rq = nodeHttp.request(URL + path, { method: 'POST', agent, headers: { Authorization: 'Bearer dev:typed', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) } },
      (res: { statusCode: number; on: (e: string, f: (x?: Buffer) => void) => void }) => {
        const cs: Buffer[] = []; res.on('data', (c) => cs.push(c!));
        res.on('end', () => { const t = Buffer.concat(cs).toString(); if (res.statusCode >= 500) fives.push(`${path} ${res.statusCode}`); resolve({ status: res.statusCode, body: t ? JSON.parse(t) : null }); });
      });
    rq.on('error', reject); rq.write(b); rq.end();
  });
}
function get(path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    nodeHttp.get(URL + path, { agent, headers: { Authorization: 'Bearer dev:typed' } }, (res: { on: (e: string, f: (x?: Buffer) => void) => void }) => {
      const cs: Buffer[] = []; res.on('data', (c) => cs.push(c!)); res.on('end', () => resolve(JSON.parse(Buffer.concat(cs).toString())));
    }).on('error', reject);
  });
}
// the word a user types for each unit (the first rule word that maps to it)
const UNIT_RULES = (rules as unknown as { units: Record<string, { words: string[]; as?: string }> }).units;
const WORD: Record<string, string> = {};
for (const [u, r] of Object.entries(UNIT_RULES)) if (!r.as && !WORD[u]) WORD[u] = r.words.find((w) => !w.includes(' ') && w.length > 2) ?? r.words[0];
// 'piece' has no words of its own: count's words ("1 piece paneer") read as the dish's own counted unit, count or piece
WORD.piece = WORD.count;
const sameUnit = (got: string, typed: string) => got === typed || (['count', 'piece'].includes(got) && ['count', 'piece'].includes(typed));
const counts = (it: Item) => { const k = kindOf(it as never, false); return k === 'counted' || k === 'batch'; };

(URL ? describe : describe.skip)('rg8 B2: typed "1 {unit} {dish}" for every dish × supported unit', () => {
  test('0 silent mismatches, 0 server 5xx', async () => {
    const dishes: { id: string; name: string; supported_units: string[] }[] = await get('/v1/dishes');
    const silent: string[] = [], differs: string[] = [], skipped: string[] = [];
    let local = 0, server = 0;
    const jobs: (() => Promise<void>)[] = [];
    for (const d of dishes) for (const u of d.supported_units.filter((x, i, a) => !(x === 'piece' && a.includes('count')))) { // count + piece: typed the same
      const w = WORD[u];
      if (!w) { skipped.push(`${d.id}/${u}`); continue; } // a unit with no word of its own ('piece' is typed as count's words)
      const text = `1 ${w} ${d.name}`;
      // local path (the phone has the dish)
      const p = parseLocal(text);
      const its = p.items.filter((x) => !isPlaceholder(x) && x.dish_id);
      if (its.length === 1 && its[0].dish_id === d.id && !p.unmatched.length) {
        local++;
        const it = its[0];
        if (counts(it) && (!sameUnit(it.unit, u) || Math.abs(it.quantity - 1) > 1e-6)) silent.push(`local ${text}: ${it.quantity} ${it.unit}`);
      }
      // server path: the phone doesn't know the dish; the amount extraction builds what goes out ('qqzx' stands in for it)
      const probe = parser.parse(`1 ${w} qqzx`);
      const span = probe.unmatched[0];
      const a = probe.amounts?.[span];
      const sent = sentText(span, probe.amounts).replace(/qqzx$/, d.name);
      jobs.push(async () => {
        server++;
        const r = await post('/v1/parse', { text: sent, use_ai: false });
        const got = ((r.body?.items ?? []) as Item[]).filter((x) => x.dish_id && !x.ai_estimate);
        const mine = got.find((x) => x.dish_id === d.id) ?? got[0];
        if (!mine) return; // the server didn't match it as a table dish: an estimate / open row, never counted silently
        const shown = flagAmount(mine, a);
        const same = sameUnit(mine.unit, u) && Math.abs(mine.quantity - 1) < 1e-6;
        if (!same) differs.push(`${sent}: server ${mine.quantity} ${mine.unit}`);
        if (!same && counts(shown)) silent.push(`server ${sent}: ${mine.quantity} ${mine.unit}`);
      });
    }
    for (let i = 0; i < jobs.length; i += 16) await Promise.all(jobs.slice(i, i + 16).map((j) => j()));
    const out = { dishes: dishes.length, local, server, skipped: skipped.length, differs: differs.length, silent: silent.length, fives: fives.length, examples: { differs: differs.slice(0, 15), silent: silent.slice(0, 15), skipped: skipped.slice(0, 5) } };
    require('fs').writeFileSync(process.env.TYPED_OUT ?? '/tmp/typed-units.json', JSON.stringify({ ...out, all: { differs, silent, fives } }, null, 1));
    console.log(JSON.stringify(out));
    expect(silent).toEqual([]);
    expect(fives).toEqual([]);
  });
});
