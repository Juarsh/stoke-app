// Maps a parsed item to Designer's "item source → visual" table (design-notes v4).
// Accepts the announced backend fields (source: table|ai_estimate|did_you_mean|generic,
// needs_confirmation) and today's fields (ai_estimate, needs_confirm, dish source
// like "estimate"/"usda_fdc"), so it works before and after the backend change.
import type { Item } from '../parser';

export type ItemKind = 'table' | 'ai_estimate' | 'did_you_mean' | 'generic';
export type AnyItem = Item & { needs_confirmation?: boolean; generic_note?: string };
const KINDS = new Set<ItemKind>(['table', 'ai_estimate', 'did_you_mean', 'generic']);

export function itemKind(it: AnyItem): ItemKind {
  if (KINDS.has(it.source as ItemKind)) return it.source as ItemKind;
  if (it.ai_estimate) return 'ai_estimate';
  if (it.needs_confirm) return 'did_you_mean';
  return 'table';
}
export function needsConfirmation(it: AnyItem): boolean {
  if (typeof it.needs_confirmation === 'boolean') return it.needs_confirmation;
  const k = itemKind(it);
  return k !== 'table';
}
