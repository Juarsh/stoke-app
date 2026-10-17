import { createContext, ReactNode, useContext } from 'react';
import { Modal, Pressable, StyleSheet, PressableProps, ScrollView, Text, TextInput, TextInputProps, TextProps, View, ViewProps } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { makeStyles, useTheme } from '../theme';
import { devaFamily, hasDevanagari, typeScale } from '../theme/tokens';
import { Glows, Grad } from './Gradient';
import { Icon } from './Icon';

/** True inside a Card: the light `over` grey is only legible (≥4.5:1) on a card, never on the bare background. */
const OnCard = createContext(false);

type Variant = keyof typeof typeScale;
export type Tone = 'text' | 'text2' | 'muted' | 'em' | 'emChip' | 'gold' | 'goldOnGrad' | 'ai' | 'danger' | 'over' | 'onGrad' | 'onCoach' | 'onCheck' | 'popText' | 'steps' | 'freeze' | 'warn' | 'delete' | 'accentText' | 'onAccent'
  | 'primary' | 'primaryText' | 'accent' | 'aiText' | 'onPrimary' | 'infoText';
export function T({ v = 'body', tone = 'text', style, children, ...p }: TextProps & { v?: Variant; tone?: Tone }) {
  const t = useTheme();
  const onCard = useContext(OnCard);
  // design rule: light-mode `over` grey never on bare background -> fall back to text-2 there
  const tn: Tone = tone === 'over' && !t.dark && !onCard ? 'text2' : tone;
  const base = t.type[v];
  const fam = hasDevanagari(children) ? devaFamily(base.fontFamily) : base.fontFamily;
  return (
    <Text {...p} maxFontSizeMultiplier={1.3} style={[base, { fontFamily: fam, color: t.c[tn], fontVariant: ['tabular-nums'] }, style]}>
      {children}
    </Text>
  );
}

export function Screen({ children, scroll = true, title, right, eyebrow }: { children: ReactNode; scroll?: boolean; title?: string; right?: ReactNode; eyebrow?: string }) {
  const s = useStyles();
  const body = (
    <View style={s.pad}>
      {title ? (
        <View style={s.bar}>
          <View>{eyebrow ? <T v="eyebrow" tone="muted">{eyebrow}</T> : null}<T v="title">{title}</T></View>
          {right}
        </View>
      ) : null}
      {children}
    </View>
  );
  return (
    <View style={{ flex: 1 }}>
      <Glows />
      <SafeAreaView edges={['top']} style={{ flex: 1 }}>{scroll ? <ScrollView keyboardShouldPersistTaps="handled">{body}</ScrollView> : body}</SafeAreaView>
    </View>
  );
}

type CardTone = 'card' | 'card2' | 'tint' | 'tintGold' | 'aiBg' | 'track' | 'coach' | 'glass' | 'surface' | 'surface2' | 'primarySoft' | 'accentSoft' | 'infoSoft' | 'aiSoft';
/** Tinted 90%-opaque "glass-look" card: NO live blur. Hairline border + 1px top highlight. */
export function Card({ style, tone = 'card', dashed, outline, children, ...p }: ViewProps & { tone?: CardTone; dashed?: boolean; outline?: 'check' }) {
  const t = useTheme(); const s = useStyles();
  const coach = tone === 'coach';
  const bg = coach ? 'transparent' : t.c[(tone === 'glass' ? 'card' : tone) as keyof typeof t.c] as string;
  return (
    <OnCard.Provider value>
      <View {...p} style={[s.card, { backgroundColor: bg }, coach && { overflow: 'hidden', borderWidth: 0 },
        dashed && { borderStyle: 'dashed', borderColor: t.c.ai, borderWidth: 1.5 }, outline === 'check' && { borderColor: t.c.text2, borderWidth: 1.5 }, style]}>
        {coach ? <View style={[StyleSheet.absoluteFill, { backgroundColor: t.c.coach1 }]} pointerEvents="none" /> : <View style={s.highlight} pointerEvents="none" />}
        {children}
      </View>
    </OnCard.Provider>
  );
}

export function Button({ title, kind = 'primary', disabled, style, ...p }: PressableProps & { title: string; kind?: 'primary' | 'soft' | 'danger' | 'ghost' | 'onCoach' | 'outline' }) {
  const t = useTheme(); const s = useStyles();
  const grad = kind === 'primary' && !disabled;
  // Designer (Oct 17): a primary Add / Save that can't save is the AddButton's disabled look, the coral fill at 40%
  const dimmed = kind === 'primary' && !!disabled;
  const bg = dimmed ? t.c.accentFill : disabled ? t.c.card2 : grad ? t.c.accentFill : kind === 'soft' ? t.c.tint : kind === 'onCoach' ? t.c.onCoachFill : 'transparent';
  const fg: Tone = dimmed ? 'onGrad' : disabled ? 'text2' : grad ? 'onGrad' : kind === 'danger' ? 'delete' : kind === 'onCoach' ? 'onCoach' : kind === 'outline' ? 'text' : 'emChip';
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} disabled={disabled} {...p}
      style={(st) => [s.btn, { backgroundColor: bg }, dimmed && { opacity: 0.4 }, grad && { overflow: 'hidden', ...t.elev.glow }, kind === 'danger' && { borderWidth: 1, borderColor: t.c.delete }, kind === 'outline' && !disabled && { borderWidth: 1.5, borderColor: t.c.muted }, st.pressed && { opacity: 0.85 }, style as object]}>
      {kind === 'danger' ? (
        // delete: always the trash icon + the word "Delete" (never colour alone)
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Icon name="trash" color={disabled ? t.c.muted : t.c.delete} size={18} />
          <T v="button" tone={fg}>{/^delete\b/i.test(title) ? title : `Delete · ${title}`}</T>
        </View>
      ) : <T v="button" tone={fg}>{title}</T>}
    </Pressable>
  );
}

/** 'Add' next to a kcal field (failed AI row, Review 'Enter kcal'): the primary button's tokens at 44 px (coral fill, dark
 * text, pill, glow), so it reads as tappable and meets 3:1 on the card. Disabled: same look at 40% opacity. */
export function AddButton({ disabled, style, ...p }: PressableProps & { accessibilityLabel: string }) {
  const t = useTheme(); const s = useStyles();
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} disabled={disabled} {...p}
      style={(st) => [s.btn, s.addBtn, { backgroundColor: t.c.accentFill }, disabled ? { opacity: 0.4 } : t.elev.glow, st.pressed && { opacity: 0.85 }, style as object]}>
      <T v="button" tone="onGrad">Add</T>
    </Pressable>
  );
}

export function Chip({ label, onPress, kind = 'primary', a11y, selected, faded }: { label: string; onPress?: () => void; kind?: 'primary' | 'ai' | 'neutral' | 'onCoach'; a11y?: string; selected?: boolean; faded?: boolean }) {
  const t = useTheme(); const s = useStyles();
  const bg = kind === 'ai' ? t.c.aiBg : kind === 'onCoach' ? t.c.onCoachFill : kind === 'neutral' && !selected ? t.c.card2 : t.c.tint;
  const fg: Tone = kind === 'ai' ? 'ai' : kind === 'onCoach' ? 'onCoach' : kind === 'neutral' && !selected ? 'text2' : 'emChip';
  return (
    <Pressable onPress={onPress} disabled={!onPress} accessibilityRole="button" accessibilityLabel={a11y ?? label} hitSlop={8} style={s.chipHit}>
      <View style={[s.chip, { backgroundColor: bg, opacity: faded ? 0.6 : 1 }, kind === 'neutral' && { borderWidth: 1, borderColor: selected ? t.c.em : t.c.cardLine }]}>
        <T v="label" tone={fg}>{label}</T>
      </View>
    </Pressable>
  );
}

export function Badge({ label, kind }: { label: string; kind: 'ai' | 'brand' | 'check' | 'gold' }) {
  const t = useTheme(); const s = useStyles();
  const bg = kind === 'ai' ? t.c.aiBg : kind === 'check' ? t.c.check : t.c.tintGold;
  const fg: Tone = kind === 'ai' ? 'ai' : kind === 'check' ? 'onCheck' : 'gold';
  return <View style={[s.badge, { backgroundColor: bg }]}><T v="micro" tone={fg}>{label.toUpperCase()}</T></View>;
}

export function Field(p: TextInputProps & { label?: string; big?: boolean }) {
  const t = useTheme(); const s = useStyles();
  const base = p.big ? { ...t.type.body, fontSize: 17, lineHeight: 24 } : t.type.body;
  const fam = hasDevanagari(p.value ?? p.defaultValue ?? '') ? devaFamily(base.fontFamily) : base.fontFamily;
  return (
    <View style={{ gap: 4 }}>
      {p.label ? <T v="caption" tone="muted">{p.label}</T> : null}
      <TextInput placeholderTextColor={t.c.muted} selectionColor={t.c.em} {...p} style={[s.field, base, { fontFamily: fam, color: t.c.text }, p.big && s.fieldBig, p.style]} />
    </View>
  );
}

export function Segmented<V extends string>({ value, options, onChange }: { value: V; options: { value: V; label: string }[]; onChange: (v: V) => void }) {
  const t = useTheme(); const s = useStyles();
  return (
    <View style={s.seg} accessibilityRole="radiogroup">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable key={o.value} onPress={() => onChange(o.value)} accessibilityRole="radio" accessibilityState={{ selected: on }}
            style={[s.segItem, on && { backgroundColor: t.dark ? t.c.tint : t.c.card2, ...t.elev.e1 }]}>
            <T v="label" tone={on ? 'emChip' : 'muted'}>{o.label}</T>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Row({ style, ...p }: ViewProps) { return <View {...p} style={[{ flexDirection: 'row', alignItems: 'center', gap: 8 }, style]} />; }

export function Sheet({ visible, onClose, title, children }: { visible: boolean; onClose: () => void; title?: string; children: ReactNode }) {
  const t = useTheme(); const s = useStyles();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={[s.scrim, { backgroundColor: t.c.scrim }]} onPress={onClose} accessibilityLabel="Close" />
      <OnCard.Provider value>
        <View style={[s.sheet, t.elev.e3]}>
          {title ? <T v="headline" style={{ marginBottom: 4 }}>{title}</T> : null}
          {children}
        </View>
      </OnCard.Provider>
    </Modal>
  );
}

export function Popover({ visible, onClose, lines }: { visible: boolean; onClose: () => void; lines: string[] }) {
  const t = useTheme(); const s = useStyles();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={s.popWrap} onPress={onClose}>
        <View style={[s.pop, { backgroundColor: t.c.popBg }, t.elev.e2]} accessibilityLiveRegion="polite">
          {lines.map((l, i) => <T key={i} v={i === 0 ? 'bodyStrong' : 'caption'} tone="popText">{l}</T>)}
        </View>
      </Pressable>
    </Modal>
  );
}

const useStyles = makeStyles((t) => ({
  pad: { padding: t.space.screen, gap: t.space.gap, paddingBottom: t.sizes.nav + t.space.xxl * 2 },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: t.space.xs },
  card: { borderRadius: t.radius.card, paddingVertical: t.space.cardV, paddingHorizontal: t.space.cardH, gap: t.space.xs,
    borderWidth: 1, borderColor: t.c.cardLine, ...t.elev.e1 },
  highlight: { position: 'absolute', top: 0, left: t.radius.card / 2, right: t.radius.card / 2, height: 1, backgroundColor: t.c.cardHighlight },
  btn: { minHeight: t.sizes.touch, borderRadius: t.radius.button, alignItems: 'center', justifyContent: 'center', paddingHorizontal: t.space.md },
  addBtn: { minHeight: 44, height: 44, minWidth: 72 },
  chipHit: { minHeight: t.sizes.touch, justifyContent: 'center' },
  chip: { height: t.sizes.chip, borderRadius: t.radius.chip, paddingHorizontal: t.space.sm, justifyContent: 'center' },
  badge: { borderRadius: t.radius.full, paddingHorizontal: t.space.xs, paddingVertical: 2 },
  field: { minHeight: t.sizes.touch, borderRadius: t.radius.field, borderWidth: 1, borderColor: t.c.cardLine, backgroundColor: t.c.card2, paddingHorizontal: t.space.md },
  fieldBig: { minHeight: 56, paddingVertical: 14, borderWidth: 1.5, borderColor: t.c.em, backgroundColor: t.c.card, textAlignVertical: 'top' as const, outlineStyle: 'none' as never },
  seg: { flexDirection: 'row', backgroundColor: t.c.track, borderRadius: t.radius.full, padding: 3 },
  segItem: { flex: 1, minHeight: 40, alignItems: 'center', justifyContent: 'center', borderRadius: t.radius.full },
  scrim: { flex: 1 },
  sheet: { backgroundColor: t.c.navSolid, borderTopLeftRadius: t.radius.sheet, borderTopRightRadius: t.radius.sheet, padding: t.space.lg, gap: t.space.sm },
  popWrap: { flex: 1, justifyContent: 'center', padding: t.space.lg },
  pop: { borderRadius: t.radius.popover, padding: t.space.sm, gap: 2 },
}));
