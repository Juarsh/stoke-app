import dishesJson from '../data/dishes.json';
import rulesJson from '../data/rules.json';
import { Dish, Parser, Rules } from './parser';

export * from './parser';
export const DISHES = dishesJson as unknown as Dish[];
/** Dish table version: max per-dish version, stored on every saved entry. */
export const DISH_TABLE_VERSION = DISHES.reduce((m, d) => Math.max(m, d.version ?? 1), 1);
export const parser = new Parser(DISHES, rulesJson as unknown as Rules);
export const RULES = rulesJson as unknown as Rules;

// entries record variant_dish_id only for a variant the user picked or named (see domain.namedVariant)
import { setVariantGroupLookup } from '../lib/domain';
setVariantGroupLookup((id) => parser.variantGroup(id));
