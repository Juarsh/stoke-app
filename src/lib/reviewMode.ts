import type { Item } from '../parser';
/** Designer: when every item is an AI estimate, drop dashed outlines, show one line on top and a 'Confirm & add' button. */
export const reviewHeader = (items: Pick<Item, 'ai_estimate'>[]) => ({ allEstimates: items.length > 0 && items.every((i) => i.ai_estimate) });
