import { memo } from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme';
import { Grad } from './Gradient';
import { Icon } from './Icon';

const glyph: Record<string, string> = { bread: 'circle', rice: 'bowl', dal: 'bowl', main: 'bowl', combo: 'plate', protein: 'drop', breakfast: 'circle', snack: 'circle', drink: 'cup', fruit: 'leaf', sweet: 'star', condiment: 'drop' };
/** Gradient food tile with a simple line glyph (decorative; colour picked by a stable hash). */
export const FoodTile = memo(function FoodTile({ seed, category, size }: { seed: string; category?: string; size?: number }) {
  const t = useTheme();
  const n = size ?? t.sizes.tile;
  let h = 0; for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) | 0;
  const pair = t.c.tile[Math.abs(h) % t.c.tile.length];
  return (
    <View style={{ width: n, height: n, borderRadius: t.radius.tile, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }} importantForAccessibility="no-hide-descendants">
      <Grad colors={pair} />
      <Icon name={glyph[category ?? ''] ?? 'circle'} color={t.c.onCoach} size={n * 0.5} />
    </View>
  );
});
