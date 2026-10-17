// Builds a demo app state (mock user, profile, 10 days of logs) for QA screenshots.
import { addDays, entryFromItem, localDate, reopenRejected, reviewEntry, Slot } from '../src/lib/domain';
import { DISH_TABLE_VERSION, parser } from '../src/parser';
import { adoptServer, holdForUnits } from '../src/lib/serverRow';

const today = localDate();
const meals: [number, Slot, string][] = [
  [0, 'breakfast', '1 plate poha, chai'], [0, 'lunch', '3 roti rajma'], [0, 'snacks', 'chai'],
  ...[1, 2, 3, 5, 6, 7, 8, 9].flatMap((d) => [[d, 'lunch', '2 roti dal sabzi'], [d, 'dinner', 'paneer butter masala 2 roti']] as [number, Slot, string][]),
];
let n = 0;
const entries = meals.flatMap(([back, slot, text]) =>
  parser.parse(text).items.map((it) => entryFromItem(it, { id: `seed-${n++}`, slot, raw_text: text, local_date: addDays(today, -back), tableVersion: DISH_TABLE_VERSION })));
const theme = process.argv[2] ?? 'light';
// 'aireview': items to review = 3 AI estimates (own 'Add · N kcal'), 1 failed row (Enter kcal), 1 bare biryani (Choose type)
if (process.argv[3] === 'aireview') {
  const ai = (name: string, k: number, p: number) => ({ ...parser.unknown(name), ai_estimate: true, source: 'ai_estimate' as const, data_source: 'ai', dish_id: '',
    kcal: { low: Math.round(k * 0.8), best: k, high: Math.round(k * 1.25) }, protein_g: { low: p, best: p, high: p }, needs_confirmation: true });
  const o = (id: string, raw: string) => ({ slot: 'lunch' as Slot, raw_text: raw, local_date: today, tableVersion: DISH_TABLE_VERSION, id });
  entries.push(reviewEntry(ai('kombucha', 60, 0), o('r1', 'kombucha')), reviewEntry(ai('sushi', 320, 12), o('r2', 'sushi')), reviewEntry(ai('hummus', 180, 6), o('r3', 'hummus')),
    reviewEntry({ ...parser.unknown('zanthu'), needs_input: true } as never, o('r4', 'zanthu')), reviewEntry(parser.parse('biryani').items[0], o('r5', 'biryani')));
}
// 'syncfail': today's lunch (rajma) could not be synced: its row says "Couldn’t sync this. Tap to retry" and still counts
if (process.argv[3] === 'syncfail') {
  const i = entries.findIndex((e) => e.local_date === today && e.slot === 'lunch' && e.dish_id === 'rajma');
  entries[i] = { ...entries[i], sync_error: 'sync_conflict' };
}
// 'rg6': rows the server saved differently (F1) and an edit that needs a type (F4): a review row with the server's reason
// (dal sent in piece by an older build), a counted row with "Saved as …", and "Pick a type to save this." (veg biryani)
if (process.argv[3] === 'rg6') {
  const t = (id: string, dish: string, qty: number, unit: string, slot: Slot) => ({ ...entryFromItem({ ...parser.recompute(dish, qty, unit, ''), needs_confirmation: false },
    { id, slot, raw_text: `${qty} ${unit} ${parser.dishById(dish)!.name}`, local_date: today, tableVersion: DISH_TABLE_VERSION }), qty, unit });
  const dal = parser.recompute('dal', 1, 'katori', '');
  entries.push(adoptServer(t('g1', 'dal', 1, 'piece', 'dinner'), { version: 1, state: 'needs_review', dish_id: 'dal', qty: 1, unit: 'katori', kcal_best: dal.kcal.best }));
  entries.push(adoptServer(t('g2', 'dal', 2, 'katori', 'snacks'), { version: 1, state: 'corrected', dish_id: 'dal', qty: 1, unit: 'katori', kcal_best: dal.kcal.best, kcal_low: dal.kcal.low, kcal_high: dal.kcal.high,
    protein_best: dal.protein_g.best, protein_low: dal.protein_g.low, protein_high: dal.protein_g.high }));
  entries.push({ ...t('g3', 'veg_biryani', 1, 'plate', 'dinner'), variant_dish_id: 'veg_biryani', server_version: 1, sync_error: 'variant_required', sync_reason: 'Pick a type to save this.',
    variant_options: parser.variantGroup('veg_biryani', 1, 'plate') ?? [] });
  // PE: a dish the phone has no units for yet (new on the server, not pulled): held, 'Check amount', not counted
  const k = { ...parser.unknown('kodo khichdi'), dish_id: 'kodo_khichdi', name: 'kodo khichdi', source: 'table', data_source: 'table', ai_estimate: false, quantity: 1, unit: 'katori',
    kcal: { low: 170, best: 210, high: 260 }, protein_g: { low: 4.5, best: 6, high: 7.5 }, carbs_g: 34, fat_g: 5, needs_confirmation: false } as never;
  entries.push(holdForUnits(entryFromItem(k, { id: 'g4', slot: 'breakfast', raw_text: '1 katori kodo khichdi', local_date: today, tableVersion: DISH_TABLE_VERSION })));
}
// 'rg7': a save the server answered 5xx three times (flagged, not counted), a newly pulled dish (zarda pulao, server table
// v5) refused for a type pick (the server's types in Review), an older-table phone's dal in plates (unit note), an empty unit
let dishUnits: unknown;
if (process.argv[3] === 'rg7') {
  const t = (id: string, dish: string, qty: number, unit: string, slot: Slot) => ({ ...entryFromItem({ ...parser.recompute(dish, qty, unit, ''), needs_confirmation: false },
    { id, slot, raw_text: `${qty} ${unit} ${parser.dishById(dish)!.name}`, local_date: today, tableVersion: DISH_TABLE_VERSION }), qty, unit });
  entries.push({ ...t('h1', 'rajma', 2, 'katori', 'dinner'), sync_error: 'server_error', server_failed: true });
  dishUnits = { version: 5, units: { zarda_pulao: ['count', 'katori', 'spoon', 'plate', 'gram'] }, names: { zarda_pulao: 'zarda pulao' } };
  const z = { ...parser.unknown('zarda'), dish_id: 'zarda_pulao', name: 'zarda pulao', matched_text: 'zarda', source: 'table', data_source: 'table', ai_estimate: false, quantity: 1, unit: 'katori',
    kcal: { low: 320, best: 390, high: 470 }, protein_g: { low: 4, best: 5, high: 6.5 }, carbs_g: 72, fat_g: 9, needs_confirmation: false } as never;
  const opts = [{ dish_id: 'veg_pulao', name: 'veg pulao', kcal: parser.recompute('veg_pulao', 1, 'katori', '').kcal.best, protein_g: parser.recompute('veg_pulao', 1, 'katori', '').protein_g.best },
    { dish_id: 'zarda_pulao', name: 'zarda pulao', kcal: 390, protein_g: 5 }];
  entries.push(reopenRejected(entryFromItem(z, { id: 'h2', slot: 'lunch', raw_text: '1 katori zarda', local_date: today, tableVersion: DISH_TABLE_VERSION }), 'variant_required', new Date(), opts));
  const dal = parser.recompute('dal', 1, 'katori', '');
  entries.push(adoptServer(t('h3', 'dal', 1, 'plate', 'snacks'), { version: 1, state: 'needs_review', dish_id: 'dal', qty: 1, unit: 'katori', kcal_best: dal.kcal.best }));
  entries.push(adoptServer({ ...t('h4', 'dal', 1, 'katori', 'snacks'), unit: '' }, { version: 1, state: 'needs_review', dish_id: 'dal', qty: 1, unit: 'katori', kcal_best: dal.kcal.best }));
  // rg8 B3: a delete the server answered 5xx three times (flagged on the deleted row); F-2: a custom name kept as typed
  // rg9 B3: the server still has it, so it is counted at the server's 2 roti (in the ring and in Breakfast) until the delete gets through
  const h5 = t('h5', 'roti', 2, 'count', 'breakfast');
  entries.push({ ...h5, deleted_at: new Date().toISOString(), server_version: 1, sync_error: 'server_error', server_failed: true, delete_failed: true,
    server_counts: { kcal: h5.kcal.best, protein: h5.protein_g.best }, sync_reason: 'Not deleted on the server yet.' });
  const now = new Date().toISOString();
  entries.push({ id: 'h6', local_date: today, slot: 'snacks', raw_text: 'akarsh_special_shake 250', dish_id: null, custom_name: 'akarsh_special_shake', qty: 1, unit: 'count', oil_level: '',
    kcal: { low: 250, best: 250, high: 250 }, protein_g: { low: 20, best: 20, high: 20 }, source: 'custom', source_note: 'Your entry', confirmed: true, dish_table_version: DISH_TABLE_VERSION,
    created_at: now, updated_at: now, deleted_at: null, server_version: 1, server_counts: { kcal: 250, protein: 20 } } as never);
  // rg10: a delete the server refused (403 with its reason): restored, counted at the server's numbers, says why
  const h7 = t('h7', 'idli', 2, 'count', 'lunch');
  entries.push({ ...h7, server_version: 1, server_counts: { kcal: h7.kcal.best, protein: h7.protein_g.best }, kept_on_server: true,
    server_note: 'Not deleted: the server kept this entry. This entry is locked.' });
  // next build (CEO: always restore, never re-send): a refused delete that had replaced an unsynced 3-piece edit shows the
  // server's copy (2 pieces) and says the edit wasn't saved; one whose server copy moved on (another device: 4 pieces) too
  const h8 = t('h8', 'roti', 2, 'count', 'dinner');
  entries.push({ ...h8, server_version: 1, server_counts: { kcal: h8.kcal.best, protein: h8.protein_g.best }, kept_on_server: true,
    server_note: 'Not deleted: the server kept this entry. This entry is locked for now. Your change to 3 pieces wasn’t saved. Edit it again if you still want it.' });
  const h9 = t('h9', 'roti', 4, 'count', 'dinner');
  entries.push({ ...h9, server_version: 5, server_counts: { kcal: h9.kcal.best, protein: h9.protein_g.best }, kept_on_server: true,
    server_note: 'Not deleted: the server kept this entry. Your change to 3 pieces wasn’t saved. Edit it again if you still want it.' });
  // next build: the same, but the server's copy couldn't be read: amount "—", counted at the server's last 220 (shown 220)
  const h10 = t('h10', 'roti', 3, 'count', 'snacks');
  entries.push({ ...h10, server_version: 1, server_counts: { kcal: 220, protein: 7 }, server_failed: true, amount_unknown: true, kept_on_server: true,
    server_note: 'Not deleted: the server kept this entry. Your change to 3 pieces wasn’t saved. Edit it again if you still want it.' } as never);
}
process.stdout.write(JSON.stringify({ ...(dishUnits ? { dishUnits } : {}),
  user: { id: 'qa', name: 'Akarsh Puri', email: 'qa@example.com', idToken: null, mock: true },
  profile: process.argv[3] === 'noprofile' ? null : { goal: 'maintain', sex: 'm', age: 30, heightCm: 172, weightKg: 68, activity: 'light', diet: 'veg', kcalTarget: 2350, proteinTarget: 82, stepsTarget: 8000, addStepKcal: false, showKcalOnCards: true },
  entries, steps: { [today]: 4210 }, queue: [], themePref: theme, challenge: { code: 'QA21AB', title: 'Hostel B Squad', startDate: addDays(today, -8), members: [{ name: 'Riya', days: 9 }, { name: 'Yas', days: 8 }, { name: 'Aman', days: 8 }, { name: 'Kabir', days: 6 }] }, aiQuota: { used: 0 },
  learned: { 'paneer lababdar': { dish_id: 'paneer_butter_masala', name: 'paneer butter masala', qty: 1, unit: 'katori', oil_level: 'normal', at: new Date().toISOString() },
    'chapatii': { dish_id: 'roti', name: 'roti', qty: 2, unit: 'count', oil_level: '', at: new Date().toISOString() } },
}));
