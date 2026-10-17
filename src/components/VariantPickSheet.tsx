// rg6 F4: a row the server refused because it needs a type (variant_required). Tapping "Pick a type to save this." opens
// these choices (the server's own options when it sent them, else the dish table's group at the row's amount); picking one
// re-saves the row as that type. If the pick can't be saved the reason shows here and the sheet stays open.
import { useState } from 'react';
import { View } from 'react-native';
import { displayName, type FoodEntry } from '../lib/domain';
import { parser } from '../parser';
import { Chip, Sheet, T } from './ui';

export const PICK_TYPE_COPY = 'Pick a type to save this.';
export function variantChoices(e: FoodEntry) {
  if (e.variant_options?.length) return e.variant_options;
  return (e.dish_id ? parser.variantGroup(e.dish_id, e.qty, e.unit) : null) ?? [];
}
export function VariantPickSheet({ entry, onPick, onClose }: { entry: FoodEntry | null; onPick: (dishId: string) => string | null; onClose: () => void }) {
  const [why, setWhy] = useState('');
  const opts = entry ? variantChoices(entry) : [];
  const close = () => { setWhy(''); onClose(); };
  return (
    <Sheet visible={!!entry} onClose={close} title="Which type?">
      <T v="caption" tone="muted">{PICK_TYPE_COPY}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }} testID="variant-pick">
        {opts.map((o) => (
          <Chip key={o.dish_id} kind="neutral" label={`${displayName(o.name, o.dish_id)} · ${Math.round(o.kcal)} kcal`} a11y={`Save as ${displayName(o.name, o.dish_id)}, ${Math.round(o.kcal)} calories`}
            onPress={() => { const r = onPick(o.dish_id); if (r) setWhy(r); else close(); }} />
        ))}
      </View>
      {!opts.length ? <T v="caption" tone="warn">No types found for this dish. Remove it and log it again.</T> : null}
      {why ? <T v="caption" tone="warn" accessibilityLiveRegion="polite">Not saved: {why}</T> : null}
    </Sheet>
  );
}
