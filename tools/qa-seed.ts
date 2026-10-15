// Builds a demo app state (mock user, profile, 10 days of logs) for QA screenshots.
import { addDays, entryFromItem, localDate, Slot } from '../src/lib/domain';
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
process.stdout.write(JSON.stringify({
  user: { id: 'qa', name: 'Akarsh Puri', email: 'qa@example.com', idToken: null, mock: true },
  profile: process.argv[3] === 'noprofile' ? null : { goal: 'maintain', sex: 'm', age: 30, heightCm: 172, weightKg: 68, activity: 'light', diet: 'veg', kcalTarget: 2350, proteinTarget: 82, stepsTarget: 8000, addStepKcal: false, showKcalOnCards: true },
  entries, steps: { [today]: 4210 }, queue: [], themePref: theme, challenge: null, aiUsed: {},
  learned: { 'paneer lababdar': { dish_id: 'paneer_butter_masala', name: 'paneer butter masala', qty: 1, unit: 'katori', oil_level: 'normal', at: new Date().toISOString() },
    'chapatii': { dish_id: 'roti', name: 'roti', qty: 2, unit: 'count', oil_level: '', at: new Date().toISOString() } },
}));
