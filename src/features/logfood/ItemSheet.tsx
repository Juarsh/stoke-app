// S2.1 item sheet (frames s2-detail / s2-editing): unit segments + − value + stepper on one row (the stepper drops to its
// own row when they can't fit), big kcal and protein with a dashed edit cue, carbs · fat, one Add / Update.
import { useState } from 'react';
import { Modal, Pressable, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { T } from '@/components/ui';
import { TYPED_KCAL_REASON, TYPED_PROTEIN_REASON, validTypedKcal } from '@/lib/domain';
import { parser } from '@/parser';
import { useTheme } from '@/theme';
import { amountLabel, amountOk, canStepDown, compute, editKcal, editProtein, resetEdits, setUnit, stepAmount, TrayItem, uiUnits, UiUnit } from './model';

const fmtAmt = (n: number) => String(Math.round(n * 100) / 100);
const UNIT_A11Y: Record<UiUnit, string> = { piece: 'Piece', bowl: 'Bowl', g: 'Grams', ml: 'Millilitres' };
/** Typed protein: 0 to 300 g, at most one decimal (the server's per-item limit for a typed row). */
export const validTypedProtein = (s: string) => { const n = s.trim() === '' ? NaN : Number(s); return Number.isFinite(n) && n >= 0 && n <= 300; };

export function ItemSheet({ item, editing, onClose, onDone }: { item: TrayItem; editing: boolean; onClose: () => void; onDone: (t: TrayItem) => void }) {
  const t = useTheme(); const ins = useSafeAreaInsets(); const { width, fontScale } = useWindowDimensions();
  const [cur, setCur] = useState(item);
  const [amtText, setAmtText] = useState<string | null>(null);
  const [field, setField] = useState<{ which: 'kcal' | 'protein'; text: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const d = parser.dishById(cur.dishId)!;
  const c = compute(cur);
  const units = uiUnits(d);
  const kcal = Math.round(c.kcal), protein = Math.round(c.protein * 10) / 10;
  const dot = t.dark ? t.c.accentFill : t.c.accentText;
  // one row when segments (≥56dp each) + stepper (≥160dp) fit; else the stepper gets its own row (s2-detail-13x)
  const oneRow = width - 48 >= units.length * 64 * Math.max(1, fontScale) + 8 + 176;

  /** Applies the field being typed; false (with its reason) when it can't be saved. */
  const commitField = (): TrayItem | null => {
    if (!field) return cur;
    const s = field.text.trim();
    if (field.which === 'kcal') {
      if (!validTypedKcal(s)) { setErr(TYPED_KCAL_REASON); return null; }
      const n = Math.round(Number(s));
      const next = n === kcal ? cur : editKcal(cur, n);
      setCur(next); setField(null); setErr(null); return next;
    }
    if (!validTypedProtein(s)) { setErr(TYPED_PROTEIN_REASON); return null; }
    const n = Math.round(Number(s) * 10) / 10;
    const next = n === protein ? cur : editProtein(cur, n);
    setCur(next); setField(null); setErr(null); return next;
  };
  const done = () => { const next = commitField(); if (next) onDone(next); };
  const typeAmount = (s: string) => {
    setAmtText(s);
    const n = Number(s.replace(',', '.'));
    if (s.trim() !== '' && amountOk(n)) setCur((x) => ({ ...x, amount: n }));
  };
  const seg = (u: UiUnit) => {
    const on = u === cur.unit;
    return (
      <Pressable key={u} onPress={() => { setCur(setUnit(cur, u)); setAmtText(null); }} accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={UNIT_A11Y[u]}
        style={{ minWidth: 56, height: 48, paddingHorizontal: 14, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
          backgroundColor: on ? (t.dark ? t.c.inkText : t.c.ink) : 'transparent' }}>
        <T v="bodyStrong" style={{ fontSize: 15, color: on ? (t.dark ? t.c.ink : t.c.inkText) : t.c.text2 }}>{u}</T>
      </Pressable>
    );
  };
  const segments = (
    <View accessibilityRole="radiogroup" accessibilityLabel="Unit" style={{ flexDirection: 'row', backgroundColor: t.c.sheetTile, borderRadius: 14, padding: 0 }}>
      {units.map(seg)}
    </View>
  );
  const down = canStepDown(cur);
  const stepper = (
    <View style={{ flex: oneRow ? 1 : undefined, minWidth: 160, height: 48, flexDirection: 'row', alignItems: 'center', backgroundColor: t.c.sheetTile, borderRadius: 14 }}>
      <Pressable onPress={() => { setCur(stepAmount(cur, -1)); setAmtText(null); }} disabled={!down} accessibilityRole="button" accessibilityLabel="Less" accessibilityState={{ disabled: !down }}
        style={{ width: 52, height: 48, alignItems: 'center', justifyContent: 'center', opacity: down ? 1 : 0.35 }}>
        <Icon name="minus" color={t.c.text} size={20} strokeWidth={2.2} />
      </Pressable>
      <TextInput value={amtText ?? fmtAmt(cur.amount)} onChangeText={typeAmount} onBlur={() => setAmtText(null)} keyboardType="decimal-pad" selectTextOnFocus
        accessibilityLabel={`Amount, ${amountLabel(cur.unit, cur.amount)}. Double tap to type`} selectionColor={t.c.accentText}
        style={{ flex: 1, minWidth: 48, height: 48, textAlign: 'center', color: t.c.text, ...t.type.number, fontSize: 18, outlineStyle: 'none' } as never} />
      <Pressable onPress={() => { setCur(stepAmount(cur, 1)); setAmtText(null); }} accessibilityRole="button" accessibilityLabel="More"
        style={{ width: 52, height: 48, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="plus" color={t.c.text} size={20} strokeWidth={2.2} />
      </Pressable>
    </View>
  );
  const editBox = (which: 'kcal' | 'protein', big: boolean) => (
    <TextInput autoFocus value={field!.text} onChangeText={(x) => { setField({ which, text: x }); setErr(null); }} onSubmitEditing={() => commitField()}
      keyboardType={which === 'kcal' ? 'number-pad' : 'decimal-pad'} selectTextOnFocus selectionColor={t.c.accentText}
      accessibilityLabel={which === 'kcal' ? `Calories, ${field!.text}${c.kcalEdited ? ', edited' : ''}` : `Protein, ${field!.text} grams${c.proteinEdited ? ', edited' : ''}`}
      style={{ borderWidth: 2, borderColor: t.c.honeyEdge, borderRadius: 12, paddingHorizontal: 10, width: big ? 132 : 76, height: big ? 56 : 44,
        color: t.c.text, fontFamily: t.type.display.fontFamily, fontSize: big ? 34 : 18, outlineStyle: 'none' } as never} />
  );
  const number = (which: 'kcal' | 'protein') => {
    const big = which === 'kcal', edited = big ? c.kcalEdited : c.proteinEdited;
    const val = big ? kcal.toLocaleString('en-IN') : `${protein} g`;
    const a11y = big ? `Calories, ${kcal}${edited ? ', edited' : ''}. Edit` : `Protein, ${protein} grams${edited ? ', edited' : ''}. Edit`;
    return (
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 6 }}>
        {field?.which === which ? editBox(which, big) : (
          <Pressable onPress={() => { if (commitField()) setField({ which, text: big ? String(kcal) : String(protein) }); }} accessibilityRole="button" accessibilityLabel={a11y}
            accessibilityLiveRegion={big ? 'polite' : undefined} style={{ minHeight: 48, justifyContent: 'flex-end' }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
              <T style={{ fontFamily: t.type.display.fontFamily, fontSize: big ? 40 : 20, lineHeight: big ? 46 : 26, letterSpacing: big ? -1.2 : -0.3, color: t.c.text }}>{val}</T>
              {edited ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot, marginLeft: 3, marginTop: big ? 6 : 3 }} /> : null}
            </View>
            <View style={{ borderBottomWidth: 1.5, borderStyle: 'dashed', borderColor: t.c.stateLine, marginTop: 2, marginRight: edited ? 11 : 0 }} />
          </Pressable>
        )}
        <T v="bodyStrong" tone="text2" style={{ fontSize: big ? 18 : 16, lineHeight: big ? 24 : 22, marginBottom: field?.which === which ? (big ? 10 : 8) : (big ? 9 : 5) }}>{big ? 'kcal' : 'protein'}</T>
      </View>
    );
  };
  const name = c.name;
  const doneLabel = editing ? `Update ${name}, ${amountLabel(cur.unit, cur.amount)}, ${kcal} kcal` : `Add ${amountLabel(cur.unit, cur.amount).replace(/ (pieces?|bowls?)$/, '')} ${d.name}, ${kcal} kcal`;
  const editedAny = c.kcalEdited || c.proteinEdited;
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: t.c.scrim }} onPress={onClose} accessibilityLabel="Close" />
      <View accessibilityViewIsModal style={{ backgroundColor: t.c.sheet, borderTopLeftRadius: t.radius.sheet, borderTopRightRadius: t.radius.sheet,
        paddingHorizontal: 24, paddingTop: 10, paddingBottom: 20 + ins.bottom, ...(t.dark ? { borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)' } : {}) }}>
        <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: t.c.handle, alignSelf: 'center', marginBottom: 14 }} />
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <T v="title" accessibilityRole="header" style={{ fontSize: 24, flex: 1 }} numberOfLines={2}>{name}</T>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center', marginRight: -12 }}>
            <Icon name="x" color={t.c.text} size={20} strokeWidth={2.2} />
          </Pressable>
        </View>
        <View style={{ marginTop: 18, flexDirection: oneRow ? 'row' : 'column', alignItems: oneRow ? 'center' : 'stretch', gap: 10 }}>
          {oneRow ? segments : <View style={{ flexDirection: 'row' }}>{segments}</View>}
          {stepper}
        </View>
        <View style={{ marginTop: 22, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          {number('kcal')}
          {number('protein')}
        </View>
        <View style={{ marginTop: 14, flexDirection: 'row', alignItems: 'center', minHeight: 48 }}>
          <T tone="muted" style={{ fontSize: 15, flex: 1 }}>Carbs {Math.round(c.carbs)} g · Fat {Math.round(c.fat)} g</T>
          {editedAny ? (
            <Pressable onPress={() => { setCur(resetEdits(cur)); setField(null); setErr(null); }} accessibilityRole="button" accessibilityLabel={`Reset to ${name}'s own values`}
              style={{ minHeight: 48, minWidth: 48, justifyContent: 'center', alignItems: 'flex-end' }}>
              <T v="bodyStrong" style={{ color: t.c.accentText, fontSize: 15 }}>Reset</T>
            </Pressable>
          ) : null}
        </View>
        {err ? <T v="caption" style={{ color: t.c.warn, fontSize: 14 }} accessibilityLiveRegion="polite">{err}</T> : null}
        <Pressable onPress={done} accessibilityRole="button" accessibilityLabel={doneLabel}
          style={{ marginTop: 14, height: 56, borderRadius: t.radius.button, alignItems: 'center', justifyContent: 'center', backgroundColor: t.c.accentFill,
            borderWidth: t.dark ? 0 : 1.5, borderColor: t.c.honeyEdge }}>
          <T v="bodyStrong" style={{ fontSize: 17, color: t.c.onAccent }}>{editing ? 'Update' : 'Add'}</T>
        </Pressable>
      </View>
    </Modal>
  );
}
