// rg8 B2: a span the phone can't match goes to the server WITH its amount words ("1 plate zarda", never "1 zarda"), and
// the phone keeps its own reading of the amount. A table answer whose qty/unit differs from it is flagged (unit check,
// not counted) instead of being counted silently; after saving, the server row is still the truth (adoptServer).
import type { Item, SpanAmount } from '../parser';

export type Amount = Pick<SpanAmount, 'qty' | 'unit'>;

/** the text the server reads for an unmatched span */
export const sentText = (span: string, amounts?: Record<string, SpanAmount>) => amounts?.[span]?.text ?? span;

/** a table reading whose amount isn't the one the phone read (AI estimates are open rows anyway) */
export function amountDiffers(it: Pick<Item, 'quantity' | 'unit' | 'dish_id' | 'ai_estimate'>, a?: Amount | null): boolean {
  if (!a || !it.dish_id || it.ai_estimate) return false;
  if (a.unit && it.unit !== a.unit) return true;
  return Math.abs(it.quantity - a.qty) > 1e-6;
}

/** flag it for a unit check (open row, not counted) when the server's amount differs from the phone's */
export function flagAmount<T extends Item>(it: T, a?: Amount | null): T {
  if (!amountDiffers(it, a)) return it;
  const flags = it.flags ?? [];
  return { ...it, needs_confirmation: true, one_tap_ok: false, flags: flags.includes('unit_mismatch') ? flags : [...flags, 'unit_mismatch'] };
}
