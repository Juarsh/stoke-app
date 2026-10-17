// Item card with editable chips + range popover, and the Edit bottom sheet.
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { DISHES, Item, OilLevel, parser, UNITS } from '../parser';
import { amountReason, limitReason, QTY_MAX, qtyInRange, qtyStep, type Slot } from '../lib/domain';
import { portionLabel, SLOT_LABEL, SLOTS, SOURCE_LABEL } from '../lib/labels';
import { useTheme } from '../theme';
import { FoodTile } from './FoodTile';
import { Icon } from './Icon';
import { Badge, Button, Card, Chip, Field, Popover, Row, Segmented, Sheet, T } from './ui';

export function rangeLines(it: Pick<Item, 'kcal' | 'protein_g' | 'data_source' | 'source_note'>) {
  return [
    `${it.kcal.best} kcal · range ${it.kcal.low}–${it.kcal.high} · ${SOURCE_LABEL(it.data_source)}`,
    `${it.protein_g.best} g protein · range ${it.protein_g.low}–${it.protein_g.high}`,
    it.source_note,
  ].filter(Boolean);
}

export function ItemCard({ it, slot, confirmed, remembered, plain, onEdit, onConfirm: _onConfirm, onRemove, onSlot }: {
  it: Item; slot: Slot; confirmed: boolean; remembered?: boolean; /** all-estimates screen: no dashed outline */ plain?: boolean; onEdit: (it: Item) => void; onConfirm?: () => void; onRemove: () => void; onSlot: () => void;
}) {
  const t = useTheme();
  const [pop, setPop] = useState(false);
  const [sheet, setSheet] = useState(false);
  const dish = parser.dishById(it.dish_id);
  const ai = it.ai_estimate;
  return (
    <Card dashed={ai && !confirmed && !plain}>
      <Row style={{ justifyContent: 'space-between' }}>
        <FoodTile seed={it.dish_id || it.name} category={dish?.category} size={36} />
        <Row style={{ flex: 1, flexWrap: 'wrap' }}>
          <T v="bodyStrong">{it.name}</T>
          {dish?.brand ? <Badge kind="brand" label="brand" /> : null}
          {ai ? <Badge kind="ai" label="Estimate" /> : null}
        </Row>
        <Pressable onPress={() => setPop(true)} hitSlop={12} accessibilityRole="button"
          accessibilityLabel={`${it.kcal.best} calories, estimated range ${it.kcal.low} to ${it.kcal.high}, ${SOURCE_LABEL(it.data_source)}`}>
          <Row><T v="number">{it.kcal.best}</T><Icon name="info" color={t.c.muted} size={16} /></Row>
        </Pressable>
      </Row>
      {it.default_portion && !ai ? (
        // assumed portion: inline, medium weight + dotted underline, tap opens the portion selector. No chip, no dashed outline; Add confirms it.
        <T tone="text2">Read as:{' '}
          <T v="bodyStrong" style={{ textDecorationLine: 'underline', textDecorationStyle: 'dotted' }} onPress={() => setSheet(true)}
            accessibilityRole="button" accessibilityLabel={`Portion assumed: ${portionLabel(it.quantity, it.unit)}. Double-tap to change`}>{portionLabel(it.quantity, it.unit)}</T>
          {' · '}<T tone="em" onPress={() => setSheet(true)} accessibilityRole="button">Change</T>
        </T>
      ) : null}
      <Row style={{ flexWrap: 'wrap', gap: 6 }}>
        {it.default_portion && !ai ? null : <Chip kind={ai ? 'ai' : 'primary'} label={portionLabel(it.quantity, it.unit)} a11y={`Portion, ${portionLabel(it.quantity, it.unit)}, double-tap to edit`} onPress={() => setSheet(true)} />}
        {it.oil_level ? <Chip kind={ai ? 'ai' : 'primary'} label={`oil: ${it.oil_level}`} a11y={`Oil level ${it.oil_level}, double-tap to edit`} onPress={() => setSheet(true)} /> : null}
        <Chip kind="neutral" label={`${SLOT_LABEL[slot]} ✎`} a11y={`Meal slot ${SLOT_LABEL[slot]}, double-tap to change`} onPress={onSlot} />
      </Row>
      {ai && !confirmed ? <Row><Chip kind="ai" label="Change" onPress={() => setSheet(true)} /></Row> : null}
      {remembered ? <T v="caption" tone="em">🔖 Saved from last time</T> : null}
      <Popover visible={pop} onClose={() => setPop(false)} lines={rangeLines(it)} />
      <EditSheet visible={sheet} it={it} onClose={() => setSheet(false)} onSave={(n) => { onEdit(n); setSheet(false); }} onDelete={() => { setSheet(false); onRemove(); }} />
    </Card>
  );
}

export function EditSheet({ visible, it, onClose, onSave, onDelete, slot, onSlotChange, error }: {
  visible: boolean; it: Item; onClose: () => void; onSave: (it: Item) => void; onDelete: () => void; slot?: Slot; onSlotChange?: (s: Slot) => void;
  /** why the store guard refused the save: the sheet stays open with it */ error?: string;
}) {
  const [qty, setQty] = useState(it.quantity);
  const [unit, setUnit] = useState(it.unit);
  const [oil, setOil] = useState<OilLevel>(it.oil_level);
  const [dishId, setDishId] = useState(it.dish_id);
  const [search, setSearch] = useState('');
  const table = !!parser.dishById(dishId) && !it.ai_estimate;
  // never throws while drawing (F2): an amount the table can't take (0, > 5000) keeps the last good numbers and says why
  const amountOff = table && !qtyInRange(qty);
  const preview: Item = !table ? scaleAi(it, qty) : amountOff ? it : safeEdit(it, { dishId: dishId !== it.dish_id ? dishId : undefined, quantity: qty, unit, oil: oil || undefined });
  // an AI reading scaled past the server's per-item limits (kcal > 5000, protein > 300): refused here, nothing is sent
  const tooMuch = !table ? limitReason(preview) : null;
  const blocked = amountOff || !!tooMuch;
  const step = qtyStep(unit);
  // Save = the amount the user chose: a confirmed reading, so the "unusual amount" options recompute attaches for a big
  // quantity (12 katori, 24 pieces) are the choice already made, never a new one (F3)
  const save = () => { if (!blocked) onSave(chosen(preview)); };
  const matches = search.length > 1 ? DISHES.filter((d) => d.name.includes(search.toLowerCase())).slice(0, 5) : [];
  return (
    <Sheet visible={visible} onClose={onClose} title={preview.name}>
      <T v="caption" tone="muted">Matched dish · {table ? 'from our table' : 'AI estimate'}</T>
      {table ? <Field placeholder="Change dish…" value={search} onChangeText={setSearch} accessibilityLabel="Change dish" /> : null}
      {matches.map((d) => <Chip key={d.id} kind="neutral" label={d.name} onPress={() => { setDishId(d.id); setUnit(d.unit); setQty(1); setSearch(''); }} />)}
      <T v="bodyStrong">How many?</T>
      <Row>
        <Button kind="soft" title="−" onPress={() => setQty((q) => Math.max(step, Math.round((q - step) * 100) / 100))} accessibilityLabel="Decrease" />
        <T v="displayM" style={{ minWidth: 64, textAlign: 'center' }}>{qty}</T>
        <Button kind="soft" title="+" onPress={() => setQty((q) => Math.min(QTY_MAX, Math.round((q + step) * 100) / 100))} accessibilityLabel="Increase" />
      </Row>
      {amountOff ? <T v="caption" tone="warn" accessibilityLiveRegion="polite" testID="amount-range">{amountReason(unit)}</T> : null}
      {table ? <Row style={{ flexWrap: 'wrap', gap: 6 }}>{UNITS.map((u) => <Chip key={u} kind="neutral" selected={u === unit} label={u} onPress={() => setUnit(u)} />)}</Row> : null}
      {preview.oil_level !== '' || oil ? (
        <>
          <T v="bodyStrong">Oil / ghee</T>
          <Segmented value={(oil || 'normal') as 'less' | 'normal' | 'extra'} onChange={setOil}
            options={[{ value: 'less', label: 'Less' }, { value: 'normal', label: 'Normal' }, { value: 'extra', label: 'Extra' }]} />
        </>
      ) : null}
      {slot && onSlotChange ? (
        <Segmented value={slot} onChange={onSlotChange} options={SLOTS.map((s) => ({ value: s, label: SLOT_LABEL[s] }))} />
      ) : null}
      <Card tone="tint">
        <T v="displayM" tone="emChip">{preview.kcal.best} kcal</T>
        {rangeLines(preview).map((l, i) => <T key={i} v="caption" tone="primaryText">{l}</T>)}
      </Card>
      {tooMuch ? <T v="caption" tone="warn" accessibilityLiveRegion="polite" testID="too-much">{tooMuch}</T> : null}
      {error && !blocked ? <T v="caption" tone="warn" accessibilityLiveRegion="polite" testID="refusal">Not saved: {error}</T> : null}
      <Button title="Save changes" disabled={blocked} onPress={save} />
      <Button kind="danger" title="Delete item" onPress={onDelete} />
    </Sheet>
  );
}

function scaleAi(it: Item, qty: number): Item {
  const f = it.quantity > 0 ? qty / it.quantity : 1;
  const r = (x: number, d = 0) => Math.round(x * f * 10 ** d) / 10 ** d;
  return { ...it, quantity: qty, grams: r(it.grams), kcal: { low: r(it.kcal.low), best: r(it.kcal.best), high: r(it.kcal.high) },
    protein_g: { low: r(it.protein_g.low, 1), best: r(it.protein_g.best, 1), high: r(it.protein_g.high, 1) } };
}
export function SlotCycle(s: Slot): Slot { return SLOTS[(SLOTS.indexOf(s) + 1) % SLOTS.length]; }

/** parser.edit that never throws (an out-of-range amount or bad unit keeps the item as it was). */
export function safeEdit(it: Item, ch: Parameters<typeof parser.edit>[1]): Item {
  try { return parser.edit(it, ch); } catch { return it; }
}
/** The user chose this amount in the sheet: the recompute's own "unusual amount" options (unit_options with this exact
 * quantity + unit among them) are that choice, already made. A real unit mismatch (flag) stays. */
export function chosen(it: Item): Item {
  const o = it.unit_options;
  if (!o?.length || !o.some((u) => u.qty === it.quantity && u.unit === it.unit)) return it;
  return { ...it, unit_options: undefined };
}
