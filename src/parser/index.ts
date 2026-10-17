import dishesJson from '../data/dishes.json';
import rulesJson from '../data/rules.json';
import seedUnits from '../data/supported-units.json';
import { Dish, Parser, Rules } from './parser';

export * from './parser';
export const DISHES = dishesJson as unknown as Dish[];
/** Dish table version: max per-dish version, stored on every saved entry. */
export const DISH_TABLE_VERSION = DISHES.reduce((m, d) => Math.max(m, d.version ?? 1), 1);
export const parser = new Parser(DISHES, rulesJson as unknown as Rules);
export const RULES = rulesJson as unknown as Rules;
// seed only: the pulled table's supported_units (dishes.json) and units pulled at runtime come first
parser.setSeedUnits(seedUnits as Record<string, string[]>);

// entries record variant_dish_id only for a variant the user picked or named (see domain.namedVariant)
import { setUnitLookup, setVariantGroupLookup } from '../lib/domain';
setVariantGroupLookup((id) => parser.variantGroup(id));
// the store guard: a table row in a unit the server can't save it in is refused (rg6 F1); a dish with no units on the
// phone is held for review ('Check amount', not counted)
setUnitLookup({ units: (id) => parser.unitsFor(id), name: (id) => parser.dishById(id)?.name ?? parser.pulledName(id) });
