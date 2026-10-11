import { memo } from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme';
import { Icon } from './Icon';

const glyph: Record<string, string> = { bread: 'circle', rice: 'bowl', dal: 'bowl', main: 'bowl', combo: 'plate', protein: 'drop', breakfast: 'circle', snack: 'circle', drink: 'cup', fruit: 'leaf', sweet: 'star', condiment: 'drop' };
/** Neutral food tile (seed kept for API compat) with a simple line glyph (decorative; colour picked by a stable hash). */
export const FoodTile = memo(function FoodTile({ seed, category, size }: { seed: string; category?: string; size?: number }) {
  const t = useTheme();
  const n = size ?? t.sizes.tile;
  return (
    <View style={{ backgroundColor: t.c.tileBg, width: n, height: n, borderRadius: t.radius.tile, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }} importantForAccessibility="no-hide-descendants">
      <Icon name={glyph[category ?? ''] ?? 'circle'} color={t.c.tileIcon} size={n * 0.5} />
    </View>
  );
});
