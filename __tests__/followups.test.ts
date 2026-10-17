import { ApiError, errorCode } from '../src/lib/api';
import { enqueue, flush, Op, Sender } from '../src/lib/syncQueue';
import { FoodEntry, Profile, profilePayload, reopenRejected, counted, entryFromItem } from '../src/lib/domain';
import { rejectCopy, pickVariant, variantOptions } from '../src/lib/confirmBatch';
import { pickItem, coachPicks } from '../src/lib/coach';
import { DISHES, oneTap, parser } from '../src/parser';

const prof: Profile = { goal: 'lose', sex: 'f', age: 30, heightCm: 160, weightKg: 60, activity: 'light', diet: 'veg', kcalTarget: 1600, proteinTarget: 96, maintenanceKcal: 1900, stepsTarget: 8000, addStepKcal: false, showKcalOnCards: true };
const entry = (o: Partial<FoodEntry> = {}): FoodEntry => ({ id: 'e1', local_date: '2026-10-16', slot: 'lunch', raw_text: 'thoda biryani kal ka', dish_id: 'chicken_biryani', custom_name: '', qty: 1, unit: 'plate', oil_level: '',
  kcal: { low: 275, best: 275, high: 275 }, protein_g: { low: 14, best: 14, high: 14 }, source: 'table', source_note: '', confirmed: true, dish_table_version: 3, created_at: '', updated_at: '', deleted_at: null, ...o });
const mk = (over: Partial<Sender> = {}): Sender => ({ upsertEntry: async () => {}, deleteEntry: async () => {}, resolvePending: async () => null, deleteRemembered: async () => {}, ...over });
const rej = (status: number, code?: string) => new ApiError(status, code === undefined ? 'bad' : JSON.stringify({ error: { code } }));

describe('error.code parsing', () => {
  test('nested, legacy, none', () => {
    expect(errorCode('{"error":{"code":"variant_required"}}')).toBe('variant_required');
    expect(errorCode('{"error":"profile_invalid"}')).toBe('profile_invalid');
    expect(errorCode('oops')).toBe(''); expect(rej(422, 'quantity_required').code).toBe('quantity_required');
  });
});

describe('profile re-send after sign-in', () => {
  test('payload: target, maintenance, goal, diet, age, height, weight, activity; never sex', () => {
    const p = profilePayload(prof);
    expect(Object.keys(p).sort()).toEqual(['activity_level', 'age', 'diet', 'goal', 'height_cm', 'maintenance_kcal', 'target_kcal', 'weight_kg']);
    expect(JSON.stringify(p)).not.toMatch(/sex|"f"/);
    expect(p).toMatchObject({ target_kcal: 1600, maintenance_kcal: 1900, goal: 'fat_loss', diet: 'veg', age: 30, height_cm: 160, weight_kg: 60, activity_level: 'light' });
  });
  test('queued before sign-in (one op, latest wins), sent by the next flush', async () => {
    let q: Op[] = [];
    q = enqueue(q, { kind: 'profile', id: 'profile', payload: profilePayload({ ...prof, kcalTarget: 1500 }), tries: 0 });
    q = enqueue(q, { kind: 'profile', id: 'profile', payload: profilePayload(prof), tries: 0 });
    expect(q).toHaveLength(1);
    const sent: unknown[] = [];
    const r = await flush(q, mk({ putProfile: async (p) => { sent.push(p); } }));
    expect(r.rest).toEqual([]); expect(sent).toEqual([profilePayload(prof)]);
  });
  test('422 profile_invalid: op dropped (no loop), code reported; 5xx retries', async () => {
    const q: Op[] = [{ kind: 'profile', id: 'profile', payload: profilePayload(prof), tries: 0 }];
    const r = await flush(q, mk({ putProfile: async () => { throw rej(422, 'profile_invalid'); } }));
    expect(r.profileRejected).toBe('profile_invalid'); expect(r.rest).toEqual([]);
    const r2 = await flush(q, mk({ putProfile: async () => { throw rej(503); } }));
    expect(r2.profileRejected).toBeUndefined(); expect(r2.rest[0].tries).toBe(1);
  });
  test('onboarding keeps values and shows the copy on profile error', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/app/onboarding.tsx'), 'utf8');
    expect(src).toMatch(/Couldn’t save this\. Check it and try again\./);
    expect(src).toMatch(/useState<Goal>\(pr\?\.goal/);
  });
});

describe('rejected save -> Review, copy by error.code', () => {
  test('copy keyed on code, not status', () => {
    expect(rejectCopy('variant_required')).toBe('Pick a type to save this.');
    expect(rejectCopy('quantity_required')).toBe('Pick how much to save this.');
    expect(rejectCopy('whatever')).toBe('Couldn’t save this. Check it and try again.'); expect(rejectCopy()).toBe(rejectCopy('x'));
  });
  test('flush hands back entry + code for a pick the server asks for (400 and 422 alike)', async () => {
    for (const [st, code] of [[400, 'variant_required'], [422, 'variant_required'], [422, 'quantity_required']] as const) {
      const r = await flush([{ kind: 'upsert', entry: entry(), tries: 0 }], mk({ upsertEntry: async () => { throw rej(st, code); } }));
      expect(r.rejected).toEqual([{ entry: entry(), code }]); expect(r.rest).toEqual([]);
    }
  });
  test('rg5 hard gate: any other POST 4xx is never a Review row; the row is flagged with the server reason', async () => {
    for (const st of [400, 403, 413, 422]) {
      const err = new ApiError(st, JSON.stringify({ error: 'protein_g, carbs_g and fat_g must be >= 0 (protein <= 300)' }));
      const r = await flush([{ kind: 'upsert', entry: entry(), tries: 0 }], mk({ upsertEntry: async () => { throw err; } }));
      expect(r.rejected).toEqual([]); expect(r.rest).toEqual([]);
      expect(r.failed).toEqual([{ id: 'e1', code: 'protein_g, carbs_g and fat_g must be >= 0 (protein <= 300)', sent: entry(), reason: 'protein_g, carbs_g and fat_g must be >= 0 (protein <= 300)' }]);
    }
  });
  test('no infinite retry: a refused review entry is dropped from the queue', async () => {
    const reopened = reopenRejected(entry(), 'variant_required');
    const r = await flush([{ kind: 'upsert', entry: reopened, tries: 0 }], mk({ upsertEntry: async () => { throw rej(422, 'variant_required'); } }));
    expect(r.rest).toEqual([]); expect(r.rejected).toEqual([]);
  });
  test('reopened: typed text kept, not counted, chips reopen for variant_required with the saved options', () => {
    const opts = [{ dish_id: 'veg_biryani', name: 'veg biryani', kcal: 230, protein_g: 6 }, { dish_id: 'chicken_biryani', name: 'chicken biryani', kcal: 275, protein_g: 14 }];
    const it = { ...parser.parse('1 plate veg biryani').items[0], flags: ['variant_choice'], variant_options: opts } as never;
    const saved = entryFromItem(pickVariant(it, variantOptions(it)[1]), { id: 'e1', slot: 'lunch', raw_text: 'biryani', local_date: '2026-10-16', tableVersion: 3 });
    expect(saved.variant_options).toEqual(opts);
    const r = reopenRejected(saved, 'variant_required');
    expect(r.raw_text).toBe('biryani'); expect(counted(r)).toBe(false); expect(r.reject_code).toBe('variant_required');
    expect(r.review_item?.flags).toContain('variant_choice'); expect(variantOptions(r.review_item!)).toEqual(opts);
    const q = reopenRejected(entry(), 'quantity_required');
    expect(q.review_item?.flags).toContain('vague_quantity'); expect(q.raw_text).toBe('thoda biryani kal ka');
    expect(reopenRejected(entry()).reject_code).toBe('unknown');
  });
});

describe('coach Log + undo', () => {
  test('instant only for one_tap_ok rows; others go to Log prefilled', () => {
    const picks = coachPicks(DISHES, 520, 38, 'veg');
    for (const p of picks) {
      const it = pickItem(p, (x) => parser.parse(x), oneTap);
      if (it) expect(it.one_tap_ok).toBe(true);
    }
    const src = require('fs').readFileSync(require('path').join(__dirname, '../src/app/(tabs)/coach.tsx'), 'utf8');
    expect(src).toMatch(/it\.one_tap_ok !== true\) \{ router\.push\(\{ pathname: '\/log', params: \{ prefill: p\.label \} \}\)/);
    expect(src).toMatch(/Added \{toast\.name\} · \{kc\(toast\.kcal\)\} kcal/); expect(src).toMatch(/5000/);
  });
  test('undo offline: the unsent upsert is replaced by a delete (queue persisted), server delete sent later', async () => {
    const e = entry({ id: 'c1' });
    let q: Op[] = enqueue([], { kind: 'upsert', entry: e, tries: 1, nextAt: Date.now() + 60_000 }); // offline
    q = enqueue(q, { kind: 'delete', id: 'c1', tries: 0 });
    expect(q).toEqual([{ kind: 'delete', id: 'c1', tries: 0 }]);
    const restored = JSON.parse(JSON.stringify(q)) as Op[]; // after app kill
    const del: string[] = []; const up: string[] = [];
    const r = await flush(restored, mk({ deleteEntry: async (id) => { del.push(id); }, upsertEntry: async (x) => { up.push(x.id); } }));
    expect(del).toEqual(['c1']); expect(up).toEqual([]); expect(r.rest).toEqual([]);
  });
});

import { errorDetail } from '../src/lib/api';
import { isUnverified, kindOf } from '../src/lib/confirmBatch';
describe('f1fa437 contract', () => {
  const opts = [{ dish_id: 'veg_biryani', name: 'veg biryani', kcal: 230, protein_g: 6 }, { dish_id: 'mutton_biryani', name: 'mutton biryani', kcal: 320, protein_g: 16 }];
  test('422 variant_required body: options reopen the picker; plain {error:"string"} still parses', async () => {
    const body = JSON.stringify({ error: { code: 'variant_required', item: 0, dish_id: 'chicken_biryani', message: 'pick', variant_options: opts } });
    expect(errorDetail(body)).toMatchObject({ code: 'variant_required', variant_options: opts });
    expect(errorDetail('{"error":"bad thing"}')).toEqual({ code: 'bad thing' });
    expect(errorDetail(JSON.stringify({ error: { code: 'profile_invalid', fields: { target_kcal: 'below 1200' } } })).fields).toEqual({ target_kcal: 'below 1200' });
    const r = await flush([{ kind: 'upsert', entry: entry(), tries: 0 }], mk({ upsertEntry: async () => { throw new ApiError(422, body); } }));
    expect(r.rejected[0].variant_options).toEqual(opts);
    const re = reopenRejected(r.rejected[0].entry, r.rejected[0].code, new Date(), r.rejected[0].variant_options);
    expect(variantOptions(re.review_item!)).toEqual(opts); expect(kindOf(re.review_item!, false)).toBe('unit');
  });
  test('variant save sends dish_id AND variant_dish_id = pick; text = typed phrase; confirmed true', async () => {
    jest.resetModules();
    jest.doMock('../src/lib/config', () => ({ config: { mock: false, apiUrl: 'http://x', mockAi: false } }));
    const bodies: Record<string, unknown>[] = [];
    const g = global as unknown as { fetch: unknown }; const old = g.fetch;
    g.fetch = jest.fn(async (_u: string, init: { body?: string }) => { if (init?.body) bodies.push(JSON.parse(init.body)); return { ok: true, status: 201, json: async () => ({}), text: async () => '' }; });
    try {
      const { createApi } = require('../src/lib/api');
      const it = { ...parser.parse('biryani').items[0] };
      expect(it.flags).toContain('variant_choice');
      const picked = pickVariant(it, variantOptions(it).find((o) => o.dish_id === 'veg_biryani')!);
      const e = entryFromItem(picked, { id: 'v1', slot: 'lunch', raw_text: 'kal ka biryani', local_date: '2026-10-16', tableVersion: 3 });
      await createApi(() => 't').upsertEntry(e);
      const b = bodies[0] as { text: string; items: Record<string, unknown>[] };
      expect(b.text).toBe('kal ka biryani');
      expect(b.items[0]).toMatchObject({ dish_id: 'veg_biryani', variant_dish_id: 'veg_biryani', confirmed: true });
    } finally { g.fetch = old; jest.dontMock('../src/lib/config'); }
  });
  test('local parser mirrors Go: biryani never one-taps; thoda rice confirms; brand_unmatched -> unverified row', () => {
    const b = parser.parse('biryani').items[0]; expect(oneTap(b)).toBe(false); expect(b.needs_confirmation).toBe(true);
    const t = parser.parse('thoda rice').items[0]; expect(t.flags).toContain('vague_quantity'); expect(oneTap(t)).toBe(false);
    const x = parser.parse('amul masti buttermilk').items.find((i) => i.dish_id);
    if (x && (x.flags ?? []).includes('brand_unmatched')) { expect(isUnverified(x)).toBe(true); expect(kindOf(x, false)).toBe('unverified'); }
    expect(isUnverified({ ...t, flags: ['brand_unmatched'] })).toBe(true);
  });
});

describe('1c617da: variant_dish_id on every POST and PATCH for variant-group dishes', () => {
  const run = async (e: FoodEntry, duplicate: boolean) => {
    jest.resetModules();
    jest.doMock('../src/lib/config', () => ({ config: { mock: false, apiUrl: 'http://x', mockAi: false } }));
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    const g = global as unknown as { fetch: unknown }; const old = g.fetch;
    g.fetch = jest.fn(async (_u: string, init: { method: string; body?: string }) => { calls.push({ method: init.method, body: init.body ? JSON.parse(init.body) : {} });
      return { ok: true, status: 201, json: async () => (duplicate && init.method === 'POST' ? { duplicates: [{}] } : {}), text: async () => '' }; });
    try { await require('../src/lib/api').createApi(() => 't').upsertEntry(e); } finally { g.fetch = old; jest.dontMock('../src/lib/config'); }
    return calls;
  };
  test('group membership mirrors the backend list', () => {
    for (const id of ['veg_biryani', 'chicken_biryani', 'mutton_biryani', 'egg_biryani', 'besan_chilla', 'moong_chilla']) expect([id, !!parser.variantGroup(id)]).toEqual([id, true]);
    for (const id of ['roti', 'rice', 'dal']) expect(parser.variantGroup(id)).toBeNull();
  });
  test.each([
    ['one-tap named "veg biryani"', '1 plate veg biryani', false],
    ['qty-only edit of an old entry (PATCH)', '2 moong chilla', true],
  ])('%s', async (_n, text, dup) => {
    const it = parser.parse(text).items[0];
    const e = entryFromItem({ ...it, needs_confirmation: false }, { id: 'x1', slot: 'lunch', raw_text: text, local_date: '2026-10-16', tableVersion: 3 });
    const calls = await run(dup ? { ...e, qty: e.qty + 1 } : e, dup);
    const post = calls.find((c) => c.method === 'POST')!.body as { items: Record<string, unknown>[] };
    expect(post.items[0].variant_dish_id).toBe(e.dish_id);
    if (dup) { const patch = calls.find((c) => c.method === 'PATCH')!.body; expect(patch).toMatchObject({ variant_dish_id: e.dish_id, dish_id: e.dish_id, confirmed: true }); }
  });
  test('"chiken biryani" is an open variant choice (Go agrees): no variant_dish_id unless picked', async () => {
    const it = parser.parse('chiken biryani').items[0];
    expect(it.flags).toContain('variant_choice');
    const e = entryFromItem({ ...it, needs_confirmation: false }, { id: 'c1', slot: 'lunch', raw_text: 'chiken biryani', local_date: '2026-10-16', tableVersion: 3 });
    const post = (await run(e, false))[0].body as { items: Record<string, unknown>[] };
    expect('variant_dish_id' in post.items[0]).toBe(false);
  });
  test('non-group dish sends no variant_dish_id; unchecked review rows never claim a pick', async () => {
    const it = parser.parse('2 roti').items[0];
    const e = entryFromItem(it, { id: 'r1', slot: 'lunch', raw_text: '2 roti', local_date: '2026-10-16', tableVersion: 3 });
    const post = (await run(e, false))[0].body as { items: Record<string, unknown>[] };
    expect('variant_dish_id' in post.items[0]).toBe(false);
    const rv = reopenRejected(entry({ dish_id: 'chicken_biryani' }), 'variant_required');
    const p2 = (await run(rv, false))[0].body as { items: Record<string, unknown>[] };
    expect('variant_dish_id' in p2.items[0]).toBe(false);
  });
  test('old biryani entry edited -> 422 variant_required -> back to Review with the picker', async () => {
    const opts = [{ dish_id: 'veg_biryani', name: 'veg biryani', kcal: 460, protein_g: 12 }, { dish_id: 'chicken_biryani', name: 'chicken biryani', kcal: 550, protein_g: 28 }];
    const body = JSON.stringify({ error: { code: 'variant_required', item: 0, dish_id: 'chicken_biryani', variant_options: opts } });
    const r = await flush([{ kind: 'upsert', entry: entry({ qty: 2 }), tries: 0 }], mk({ upsertEntry: async () => { throw new ApiError(422, body); } }));
    const re = reopenRejected(r.rejected[0].entry, r.rejected[0].code, new Date(), r.rejected[0].variant_options);
    expect(re.reject_code).toBe('variant_required'); expect(variantOptions(re.review_item!)).toEqual(opts); expect(rejectCopy(re.reject_code)).toBe('Pick a type to save this.');
  });
});
