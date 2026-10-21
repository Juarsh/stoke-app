// Rg10 note (CEO, next build): the note rows must use the same number format as the rest of the app's kcal. Checked first:
// every kcal in the app is en-IN grouped via Math.round(n).toLocaleString('en-IN') (ring, plate rows, Progress, Log, Add
// buttons, format.ts kc), so 1,00,000 from 100,000 up IS the app's format. The note rows now use that same formatter (kc),
// and the "Saved as" kcal is rounded like every other kcal (it printed raw decimals, e.g. "220.4").
import React from 'react';
import { act, create } from 'react-test-renderer';
import { kc } from '../src/lib/format';
import { ServerNoteRow } from '../src/components/ServerNoteRow';
import { SyncFailedRow } from '../src/components/SyncFailedRow';
import { adoptServer } from '../src/lib/serverRow';
import { entryFromItem, FoodEntry, dayOf, localDate } from '../src/lib/domain';
import { parser, DISH_TABLE_VERSION, Item } from '../src/parser';

const NUMS = [0, 7, 999, 1180, 1180.4, 99_999, 100_000, 123_456.6, 1_000_000];
const app = (n: number) => Math.round(n).toLocaleString('en-IN'); // what the ring, plate rows, Progress and Log print
const textOf = (t: ReturnType<typeof create>) => t.root.findAll((n) => typeof n.type === 'string').flatMap((n) => [n.props.children].flat()).filter((c) => typeof c === 'string').join('');

test('kc is the app’s kcal format, including around 99,999 / 1,00,000', () => {
  for (const n of NUMS) expect(kc(n)).toBe(app(n));
  expect([kc(99_999), kc(100_000), kc(1180.4)]).toEqual(['99,999', '1,00,000', '1,180']);
});
test.each(NUMS)('note row and flagged row print %d kcal exactly like the rest of the app', async (n) => {
  let t!: ReturnType<typeof create>;
  await act(async () => { t = create(<ServerNoteRow title="Lunch · Idli" kcal={n} note="x" onDismiss={() => {}} />); });
  expect(t.root.find((x) => x.props.testID === 'server-note-kcal' && typeof x.type !== 'string').props.children).toBe(`${app(n)} kcal`);
  await act(async () => { t.unmount(); });
  await act(async () => { t = create(<SyncFailedRow title="Lunch · Idli" kcal={n} retrying={false} onRetry={() => {}} />); });
  expect(textOf(t)).toContain(`${app(n)} kcal`);
  await act(async () => { t.unmount(); });
});
test('"Saved as" uses the same format, rounded (never raw decimals)', () => {
  const it = { ...parser.recompute('roti', 3, 'count', ''), needs_confirmation: false } as Item;
  const e = { ...entryFromItem(it, { id: 'A', slot: 'lunch', raw_text: '3 roti', local_date: dayOf(), tableVersion: DISH_TABLE_VERSION }), qty: 3, unit: 'count' } as FoodEntry;
  expect(adoptServer(e, { version: 2, state: 'confirmed', dish_id: 'roti', qty: 2, unit: 'count', kcal_best: 220.4, protein_best: 7 }).server_note).toBe('Saved as 2 pieces · 220 kcal.');
  const custom = { ...e, dish_id: null, custom_name: 'thali', source: 'custom' } as FoodEntry;
  expect(adoptServer(custom, { version: 2, state: 'confirmed', kcal_best: 100_000, protein_best: 0 }).server_note).toBe(`Saved as ${app(100_000)} kcal.`);
});
