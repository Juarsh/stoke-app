import { memo } from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme';
import { FoodIcon, foodIconFor } from './FoodIcon';

/** Food tile with the v3.2 food icon (decorative; always beside the item's name). seed = dish id or the user's text. */
export const FoodTile = memo(function FoodTile({ seed, category, size }: { seed: string; category?: string; size?: number }) {
  const t = useTheme();
  const n = size ?? t.sizes.tile;
  return (
    <View style={{ backgroundColor: t.c.tileBg, width: n, height: n, borderRadius: t.radius.tile, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }} importantForAccessibility="no-hide-descendants">
      <FoodIcon name={foodIconFor(seed ?? '', category)} size={Math.max(20, Math.round(n * 0.6))} />
    </View>
  );
});
