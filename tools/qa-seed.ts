// Builds a demo app state (mock user, profile, 10 days of logs) for QA screenshots.
import { addDays, entryFromItem, localDate, reviewEntry, Slot } from '../src/lib/domain';
import { DISH_TABLE_VERSION, parser } from '../src/parser';

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
process.stdout.write(JSON.stringify({
  user: { id: 'qa', name: 'Akarsh Puri', email: 'qa@example.com', idToken: null, mock: true },
  profile: process.argv[3] === 'noprofile' ? null : { goal: 'maintain', sex: 'm', age: 30, heightCm: 172, weightKg: 68, activity: 'light', diet: 'veg', kcalTarget: 2350, proteinTarget: 82, stepsTarget: 8000, addStepKcal: false, showKcalOnCards: true },
  entries, steps: { [today]: 4210 }, queue: [], themePref: theme, challenge: { code: 'QA21AB', title: 'Hostel B Squad', startDate: addDays(today, -8), members: [{ name: 'Riya', days: 9 }, { name: 'Yas', days: 8 }, { name: 'Aman', days: 8 }, { name: 'Kabir', days: 6 }] }, aiUsed: {},
  learned: { 'paneer lababdar': { dish_id: 'paneer_butter_masala', name: 'paneer butter masala', qty: 1, unit: 'katori', oil_level: 'normal', at: new Date().toISOString() },
    'chapatii': { dish_id: 'roti', name: 'roti', qty: 2, unit: 'count', oil_level: '', at: new Date().toISOString() } },
}));
