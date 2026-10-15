import { grams, kc } from '../src/lib/format';
test('comma grouping and whole grams', () => {
  expect(kc(1180)).toBe('1,180'); expect(kc(1180.4)).toBe('1,180'); expect(kc(520)).toBe('520');
  expect(grams(45.5)).toBe('46 g'); expect(grams(38)).toBe('38 g');
});
