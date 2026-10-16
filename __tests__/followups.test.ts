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
    expect(Object.keys(p).sort()).toEqual(['activity', 'age', 'diet', 'goal', 'height_cm', 'kcal_target', 'maintenance_kcal', 'protein_target', 'weight_kg']);
    expect(JSON.stringify(p)).not.toMatch(/sex|"f"/);
    expect(p).toMatchObject({ kcal_target: 1600, maintenance_kcal: 1900, goal: 'lose', diet: 'veg', age: 30, height_cm: 160, weight_kg: 60, activity: 'light' });
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
  test('flush hands back entry + code for 400 and 422 alike', async () => {
    for (const [st, code] of [[400, 'variant_required'], [422, 'variant_required'], [422, 'quantity_required'], [400, undefined]] as const) {
      const r = await flush([{ kind: 'upsert', entry: entry(), tries: 0 }], mk({ upsertEntry: async () => { throw rej(st, code); } }));
      expect(r.rejected).toEqual([{ entry: entry(), code: code ?? '' }]); expect(r.rest).toEqual([]);
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
