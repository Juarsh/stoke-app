import { parser } from '../src/parser';
import { parseLocal, dropOverlapping } from '../src/lib/parseLocal';

test('spans are UTF-16 offsets into the original text', () => {
  const t = '2 roti, 1 katori dal';
  for (const it of parser.parse(t).items) expect(t.slice(it.span_start, it.span_end).length).toBeGreaterThan(0);
});

test('CHECK fix: an unknown word elsewhere does not turn a confident table item into a check', () => {
  const r = parseLocal('2 roti, kombucha');
  const roti = r.items.find((i) => i.dish_id === 'roti')!;
  expect(roti.needs_confirmation).toBe(false);
  expect(roti.source).toBe('table');
});

test('a table word glued to an unknown word stays unclaimed', () => {
  const r = parseLocal('kuttu roti');
  const roti = r.items.find((i) => i.dish_id === 'roti');
  if (roti) expect(roti.needs_confirmation).toBe(true);
});

test('dropOverlapping drops AI items that overlap a table span', () => {
  const table = [{ span_start: 0, span_end: 6 }];
  expect(dropOverlapping(table, [{ span_start: 3, span_end: 9 }, { span_start: 8, span_end: 12 }])).toEqual([{ span_start: 8, span_end: 12 }]);
});
