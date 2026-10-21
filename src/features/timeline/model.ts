// Food timeline (spec §4, Q10, Q12): a day's counted entries by eaten-at time, in display-only blocks (entries within 45
// minutes of each other), a logged row as a tray item for the v4 item sheet (Update), and the edited row it saves.
import { countedNums, entryLabel, FoodEntry } from '@/lib/domain';
import { parser } from '@/parser';
import type { MyFood } from '@/features/myfoods/model';
import { amountLabel, buildEntries, compute, TrayItem, uiUnits, UiUnit } from '@/features/logfood/model';

export const BLOCK_GAP_MIN = 45;
export const timeOf = (e: FoodEntry) => e.eaten_at ?? e.created_at;
export interface Block { key: string; start: string; entries: FoodEntry[]; kcal: number }
/** Blocks: sorted by time; an entry within 45 minutes of the previous one joins its block (45:00 joins, 45:01 does not). */
export function blocks(entries: FoodEntry[]): Block[] {
  const sorted = [...entries].sort((a, b) => timeOf(a).localeCompare(timeOf(b)) || a.id.localeCompare(b.id));
  const out: Block[] = [];
  let prev = -Infinity;
  for (const e of sorted) {
    const t = Date.parse(timeOf(e));
    const cur = out[out.length - 1];
    if (cur && t - prev <= BLOCK_GAP_MIN * 60000) cur.entries.push(e);
    else out.push({ key: e.id, start: timeOf(e), entries: [e], kcal: 0 });
    prev = t;
  }
  for (const b of out) b.kcal = Math.round(b.entries.reduce((s, e) => s + countedNums(e).kcal, 0));
  return out;
}

const LEGACY: Record<string, UiUnit> = { count: 'piece', piece: 'piece', katori: 'bowl', gram: 'g' };
/** The row's amount in the 4-unit rule (Q10): its own display unit, else count/katori/gram as piece/bowl/g, else (plate,
 * glass, spoon from the sentence flow) the table's grams at that amount. */
export function rowAmount(e: FoodEntry): { unit: UiUnit; amount: number } {
  if (e.display_unit && e.display_amount) return { unit: e.display_unit as UiUnit, amount: e.display_amount };
  const u = LEGACY[e.unit];
  const d = e.dish_id ? parser.dishById(e.dish_id) : undefined;
  if (u && (!d || uiUnits(d).includes(u))) return { unit: u, amount: e.qty };
  if (d) { try { return { unit: 'g', amount: Math.round(parser.recompute(d.id, e.qty, e.unit, '').grams) }; } catch { /* below */ } }
  return { unit: u ?? 'piece', amount: e.qty || 1 };
}
export const amountText = (e: FoodEntry) => { const a = rowAmount(e); return amountLabel(a.unit, a.amount); };

/** True when the row is a plain table row the sheet can recompute (a dish, not edited, not an AI reading). */
const tableRow = (e: FoodEntry) => !!e.dish_id && e.source === 'table' && !e.kcal_edited && !e.protein_edited && !!parser.dishById(e.dish_id);
/** A logged row as a tray item for the item sheet (Update). A table row recomputes from the table; any other row (My food,
 * typed, edited, AI) scales from its own saved snapshot, so a past My food row never takes the food's later values. */
export function trayFromEntry(e: FoodEntry): TrayItem {
  const a = rowAmount(e);
  if (tableRow(e)) {
    const d = parser.dishById(e.dish_id!)!;
    return uiUnits(d).includes(a.unit) ? { key: e.id, dishId: d.id, unit: a.unit, amount: a.amount } : { key: e.id, dishId: d.id, unit: 'g', amount: Math.round(e.grams ?? 100) };
  }
  const snap: MyFood = { id: e.my_food_id ?? '', name: entryLabel(e), unit: a.unit, amount: a.amount, kcal: e.kcal.best, protein: e.protein_g.best,
    carbs: e.carbs_g, fat: e.fat_g, created_at: e.created_at, updated_at: e.updated_at, deleted_at: null };
  return { key: e.id, dishId: '', mine: snap, unit: a.unit, amount: a.amount };
}
/** The edited row: the sheet's numbers and the chosen time on the old row's identity (id, server version, flags), for
 * store.updateEntry (the existing sync / version path). null when nothing changed. */
export function entryFromEdit(old: FoodEntry, t: TrayItem, at: Date, now = new Date()): { entry: FoodEntry | null; reason?: string } {
  const before = trayFromEntry(old);
  const same = before.unit === t.unit && before.amount === t.amount && t.kcalPerG === undefined && t.proteinPerG === undefined && Date.parse(timeOf(old)) === at.getTime();
  if (same) return { entry: null };
  const { entries, refused } = buildEntries([t], at, { now, newId: () => old.id });
  if (refused.length) return { entry: null, reason: refused[0].reason };
  const n = entries[0], c = compute(t);
  const snapshotRow = !tableRow(old);
  const entry: FoodEntry = {
    ...old,
    local_date: n.local_date, slot: n.slot, eaten_at: n.eaten_at,
    dish_id: snapshotRow ? old.dish_id : n.dish_id,
    custom_name: n.custom_name || old.custom_name, qty: n.qty, unit: n.unit, oil_level: n.oil_level,
    kcal: n.kcal, protein_g: n.protein_g, carbs_g: n.carbs_g, fat_g: n.fat_g,
    source: snapshotRow ? (old.source === 'table' ? 'custom' : old.source) : n.source, item_source: snapshotRow ? old.item_source : n.item_source,
    source_note: snapshotRow ? old.source_note : n.source_note, dish_table_version: snapshotRow ? old.dish_table_version : n.dish_table_version,
    display_amount: t.amount, display_unit: t.unit, grams: c.grams || old.grams,
    variant_dish_id: snapshotRow ? old.variant_dish_id : n.variant_dish_id,
    kcal_edited: old.kcal_edited || c.kcalEdited || undefined, protein_edited: old.protein_edited || c.proteinEdited || undefined,
    my_food_id: old.my_food_id,
  };
  // a typed / edited table row becomes the user's own numbers (custom), like a new log
  if (!snapshotRow && (c.kcalEdited || c.proteinEdited)) Object.assign(entry, { dish_id: null, source: 'custom', item_source: undefined, variant_dish_id: undefined });
  return { entry };
}
/** Moving a whole block (§4 "Moves all N items together"): every entry keeps its offset from the block start. */
export function moveBlock(b: Block, to: Date): { id: string; at: Date }[] {
  const delta = to.getTime() - Date.parse(b.start);
  return b.entries.map((e) => ({ id: e.id, at: new Date(Date.parse(timeOf(e)) + delta) }));
}
