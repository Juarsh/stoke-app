// Designer v3.2 food + meal-slot icons (react-native-svg). Stroke/tint from theme tokens iconStroke/iconTint
// (#A8361F on #FFE3DC light, #FF8A70 on #3A1C15 dark; never accentFill). Decorative: always render next to a text label.
import { memo } from 'react';
import Svg, { Circle, G, Path, Rect } from 'react-native-svg';
import { useTheme } from '../theme';
import { FOOD_ICONS, FoodIconName } from './foodIconData';

export type { FoodIconName };
const EL = { circle: Circle, path: Path, rect: Rect } as const;

export const FoodIcon = memo(function FoodIcon({ name, size = 24 }: { name: FoodIconName; size?: number }) {
  const t = useTheme();
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"
      accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {FOOD_ICONS[name].map((g, i) => (
        <G key={i} fill={g.t ? t.c.iconTint : 'none'} stroke={t.c.iconStroke}>
          {g.e.map(([tag, a], j) => { const C = EL[tag] as unknown as React.ComponentType<Record<string, unknown>>; return <C key={j} {...a} />; })}
        </G>
      ))}
    </Svg>
  );
});

const KEYWORDS: [RegExp, FoodIconName][] = [
  [/whey|protein[ _]?(shake|powder)|shake/, 'protein-shake'], [/paratha|thepla/, 'paratha'], [/roti|chapat|phulka|naan|kulcha|bhatura|puri|bread|pav/, 'roti'],
  [/idli|dosa|uttapam|vada|appam/, 'idli-dosa'], [/poha|upma|sabudana|dalia|oats/, 'poha'], [/biryani|pulao|rice|khichdi/, 'rice'],
  [/dal|sambar|rajma|chole|chana|kadhi/, 'dal'], [/paneer|tofu|soya/, 'paneer'], [/egg|omelette|bhurji/, 'egg'],
  [/chicken|mutton|keema|kebab|tikka/, 'chicken'], [/fish|prawn|shrimp/, 'fish'], [/chai|tea/, 'chai'], [/coffee/, 'coffee'],
  [/milk|curd|dahi|lassi|raita|chaas|buttermilk|yogurt/, 'milk-curd'], [/juice|nimbu|lemonade|coconut/, 'juice'], [/water/, 'water'],
  [/salad|sprout/, 'salad'], [/samosa|pakora|kachori|bhaji|chaat|namkeen|chips/, 'samosa'], [/biscuit|cookie|rusk/, 'biscuit'],
  [/banana|apple|mango|fruit|orange|papaya|grape/, 'fruit'],
];
const BY_CATEGORY: Record<string, FoodIconName> = { bread: 'roti', rice: 'rice', dal: 'dal', main: 'sabzi', protein: 'paneer', breakfast: 'poha',
  snack: 'samosa', drink: 'juice', fruit: 'fruit', sweet: 'sweets', combo: 'lunch', condiment: 'sabzi' };
/** Pick the icon for a dish id/name (keywords first, then the dish category); unknown foods get the sabzi plate. */
export function foodIconFor(idOrName: string, category?: string): FoodIconName {
  const k = idOrName.toLowerCase();
  for (const [re, n] of KEYWORDS) if (re.test(k)) return n;
  return BY_CATEGORY[category ?? ''] ?? 'sabzi';
}
export const SLOT_ICON: Record<string, FoodIconName> = { breakfast: 'breakfast', lunch: 'lunch', snacks: 'snacks', snack: 'snacks', dinner: 'dinner' };
