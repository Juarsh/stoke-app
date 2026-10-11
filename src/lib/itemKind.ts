// Item source → visual mapping (design-notes v4), driven by the parser/backend
// `source` (table | did_you_mean | generic | ai_estimate) and `needs_confirmation`.
import type { Item, ItemSource } from '../parser';

export type ItemKind = ItemSource;
export type AnyItem = Item & { generic_note?: string };
export const itemKind = (it: Item): ItemKind => (it.ai_estimate ? 'ai_estimate' : it.source);
export const needsConfirmation = (it: Item): boolean => it.needs_confirmation;
/** Placeholder for text nothing could estimate (backend Parser.Unknown): handled as a custom item in the UI. */
export const isPlaceholder = (it: Item) => it.source === 'generic' && it.dish_id === '';
