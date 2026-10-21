// §6.4 the one My food form (No match card, + New food, edit sheet): Name, Unit, Amount · Calories · Protein, More ▾
// (carbs, fat, grams in one). The name clash (§6.5) shows live: food-colour edge and "✕ You already have this food".
import { useEffect, useRef, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { T } from '@/components/ui';
import { useTheme } from '@/theme';
import type { UiUnit } from '@/features/logfood/model';
import { amountLabel } from '@/features/logfood/model';
import { CLASH_REASON, Draft, draftUnit, Field } from './model';

const UNITS: UiUnit[] = ['piece', 'bowl', 'g', 'ml'];
const UNIT_A11Y: Record<UiUnit, string> = { piece: 'Piece', bowl: 'Bowl', g: 'Grams', ml: 'Millilitres' };

export function FoodForm({ draft, onChange, errors, clash, focus, onFocused, card = true }: {
  draft: Draft; onChange: (d: Draft) => void; errors: Partial<Record<Field, string>>; clash: boolean;
  /** a field to focus (the first error on Save); onFocused clears it */
  focus?: Field | null; onFocused?: () => void; card?: boolean;
}) {
  const t = useTheme();
  const [more, setMore] = useState(!!(draft.carbs || draft.fat || draft.unitGrams));
  const refs = useRef<Partial<Record<Field, TextInput | null>>>({});
  useEffect(() => {
    if (!focus) return;
    if (['carbs', 'fat', 'unitGrams'].includes(focus)) setMore(true);
    const id = setTimeout(() => { refs.current[focus]?.focus(); onFocused?.(); }, 50);
    return () => clearTimeout(id);
  }, [focus, onFocused]);
  const set = (k: keyof Draft) => (v: string) => onChange({ ...draft, [k]: v });
  const label = (s: string) => <T v="bodyStrong" tone="text2" style={{ fontSize: 14, marginBottom: 6 }}>{s}</T>;
  const box = (bad: boolean, edge?: string) => ({ height: 52, borderRadius: 14, borderWidth: edge ? 2 : 1.5, borderColor: edge ?? (bad ? t.c.warn : t.c.cardLine),
    backgroundColor: t.c.card, paddingHorizontal: 14, color: t.c.text, ...t.type.body, fontSize: 17, lineHeight: 22, outlineStyle: 'none' }) as never;
  const err = (k: Field) => (errors[k] ? <T v="caption" style={{ color: t.c.warn, fontSize: 13, marginTop: 4 }} accessibilityLiveRegion="polite">{errors[k]}</T> : null);
  const num = (k: 'amount' | 'kcal' | 'protein' | 'carbs' | 'fat' | 'unitGrams', a11y: string, ph?: string, suffix?: string) => (
    <View style={{ flex: 1 }}>
      <View>
        <TextInput ref={(r) => { refs.current[k] = r; }} value={draft[k]} onChangeText={set(k)} keyboardType="decimal-pad" placeholder={ph} placeholderTextColor={t.c.muted}
          accessibilityLabel={a11y} selectionColor={t.c.accentText} style={[box(!!errors[k]), suffix ? { paddingRight: 34 } : null] as never} />
        {suffix && draft[k] ? <T tone="muted" style={{ position: 'absolute', right: 12, top: 15, fontSize: 15 }} importantForAccessibility="no">{suffix}</T> : null}
      </View>
    </View>
  );
  const amt = Number(draft.amount) > 0 ? amountLabel(draft.unit, Number(draft.amount)) : draft.unit;
  const body = (
    <>
      {label('Name')}
      <TextInput ref={(r) => { refs.current.name = r; }} value={draft.name} onChangeText={set('name')} placeholder="Name" placeholderTextColor={t.c.muted}
        accessibilityLabel={`Name, ${draft.name || 'empty'}`} accessibilityState={{ invalid: clash } as never} autoCapitalize="sentences" selectionColor={t.c.accentText}
        style={box(!!errors.name && !clash, clash ? t.c.food : undefined)} />
      {clash ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }} accessibilityRole="alert" accessibilityLiveRegion="polite">
          <Icon name="x" color={t.c.foodText} size={14} strokeWidth={2.4} />
          <T v="bodyStrong" style={{ color: t.c.foodText, fontSize: 14 }}>{CLASH_REASON}</T>
        </View>
      ) : err('name')}
      <View style={{ height: 16 }} />
      {label('Unit')}
      <View accessibilityRole="radiogroup" accessibilityLabel="Unit" style={{ flexDirection: 'row', backgroundColor: t.c.sheetTile, borderRadius: 14 }}>
        {UNITS.map((u) => {
          const on = u === draft.unit;
          return (
            <Pressable key={u} onPress={() => onChange(draftUnit(draft, u))} accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={UNIT_A11Y[u]}
              style={{ flex: 1, minWidth: 56, height: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? (t.dark ? t.c.inkText : t.c.ink) : 'transparent' }}>
              <T v="bodyStrong" style={{ fontSize: 15, color: on ? (t.dark ? t.c.ink : t.c.inkText) : t.c.text2 }}>{u}</T>
            </Pressable>
          );
        })}
      </View>
      <View style={{ height: 16 }} />
      <View style={{ flexDirection: 'row', gap: 12 }}>
        <View style={{ flex: 1 }}>{label('Amount')}</View><View style={{ flex: 1 }}>{label('Calories')}</View><View style={{ flex: 1 }}>{label('Protein')}</View>
      </View>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        {num('amount', `Amount, ${amt}`, undefined, draft.unit === 'g' || draft.unit === 'ml' ? draft.unit : undefined)}
        {num('kcal', `Calories for ${amt}, ${draft.kcal || 'empty'}`)}
        {num('protein', `Protein, grams, ${draft.protein || 'empty'}`, 'g', 'g')}
      </View>
      {err('amount')}{err('kcal')}{err('protein')}
      <Pressable onPress={() => setMore(!more)} accessibilityRole="button" accessibilityState={{ expanded: more }} accessibilityLabel="More: carbs and fat, optional"
        style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', marginTop: 4 }}>
        <T v="bodyStrong" tone="text2" style={{ fontSize: 15 }}>More</T>
        <View style={{ transform: [{ rotate: more ? '180deg' : '0deg' }] }}><Icon name="down" color={t.c.text2} size={16} strokeWidth={2.2} /></View>
      </Pressable>
      {more ? (
        <>
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <View style={{ flex: 1 }}>{label('Carbs')}</View><View style={{ flex: 1 }}>{label('Fat')}</View>
            <View style={{ flex: 1 }}>{draft.unit === 'piece' || draft.unit === 'bowl' ? label(`1 ${draft.unit} weighs`) : null}</View>
          </View>
          <View style={{ flexDirection: 'row', gap: 12 }}>
            {num('carbs', 'Carbs, grams, optional', 'g', 'g')}
            {num('fat', 'Fat, grams, optional', 'g', 'g')}
            {draft.unit === 'piece' || draft.unit === 'bowl' ? num('unitGrams', `Grams in 1 ${draft.unit}, optional`, 'g', 'g') : <View style={{ flex: 1 }} />}
          </View>
          {err('carbs')}{err('fat')}{err('unitGrams')}
        </>
      ) : null}
    </>
  );
  return card ? (
    <View style={{ backgroundColor: t.c.card, borderRadius: t.radius.card, borderWidth: 1, borderColor: t.c.lineSoft, padding: 20, paddingBottom: 8 }}>{body}</View>
  ) : <View>{body}</View>;
}
