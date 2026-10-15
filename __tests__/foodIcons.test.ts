import { FOOD_ICONS } from '../src/components/foodIconData';
import { foodIconFor } from '../src/components/FoodIcon';
import { palette } from '../src/theme/tokens';
const { light, dark } = palette;

test('26 icons: 22 foods + 4 slots', () => expect(Object.keys(FOOD_ICONS)).toHaveLength(26));
test('icon colours are tokens, never accentFill', () => {
  expect([light.iconStroke, light.iconTint, dark.iconStroke, dark.iconTint]).toEqual(['#A8361F', '#FFE3DC', '#FF8A70', '#3A1C15']);
});
test('dish -> icon', () => {
  expect(foodIconFor('roti', 'bread')).toBe('roti');
  expect(foodIconFor('masala_dosa', 'breakfast')).toBe('idli-dosa');
  expect(foodIconFor('kombucha')).toBe('sabzi');
  expect(foodIconFor('gulab_jamun', 'sweet')).toBe('sweets');
});
