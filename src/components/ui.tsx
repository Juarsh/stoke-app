import { ReactNode } from 'react';
import { Modal, Pressable, PressableProps, ScrollView, Text, TextInput, TextInputProps, TextProps, View, ViewProps } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { makeStyles, useTheme } from '../theme';
import type { typeScale } from '../theme/tokens';

type Variant = keyof typeof typeScale;
type Tone = 'text' | 'text2' | 'muted' | 'primary' | 'primaryText' | 'accent' | 'ai' | 'aiText' | 'danger' | 'over' | 'onPrimary' | 'infoText' | 'popText' | 'steps';
export function T({ v = 'body', tone = 'text', style, ...p }: TextProps & { v?: Variant; tone?: Tone }) {
  const t = useTheme();
  return <Text {...p} maxFontSizeMultiplier={1.3} style={[t.type[v], { color: t.c[tone], fontVariant: ['tabular-nums'] }, style]} />;
}

export function Screen({ children, scroll = true, title, right }: { children: ReactNode; scroll?: boolean; title?: string; right?: ReactNode }) {
  const s = useStyles();
  const body = <View style={s.pad}>{title ? <View style={s.bar}><T v="title">{title}</T>{right}</View> : null}{children}</View>;
  return <SafeAreaView edges={['top']} style={s.screen}>{scroll ? <ScrollView keyboardShouldPersistTaps="handled">{body}</ScrollView> : body}</SafeAreaView>;
}

export function Card({ style, tone = 'surface', dashed, ...p }: ViewProps & { tone?: 'surface' | 'glass' | 'primarySoft' | 'accentSoft' | 'infoSoft' | 'aiSoft' | 'surface2'; dashed?: boolean }) {
  const t = useTheme(); const s = useStyles();
  return <View {...p} style={[s.card, { backgroundColor: t.c[tone] }, tone === 'glass' && { borderColor: t.c.glassBorder, borderWidth: 1 }, dashed && { borderStyle: 'dashed', borderColor: t.c.ai, borderWidth: 1.5 }, style]} />;
}

export function Button({ title, kind = 'primary', disabled, style, ...p }: PressableProps & { title: string; kind?: 'primary' | 'soft' | 'danger' | 'ghost' }) {
  const t = useTheme(); const s = useStyles();
  const bg = disabled ? t.c.surface3 : kind === 'primary' ? t.c.primary : kind === 'soft' ? t.c.primarySoft : 'transparent';
  const fg = disabled ? 'muted' : kind === 'primary' ? 'onPrimary' : kind === 'danger' ? 'danger' : 'primaryText';
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} disabled={disabled} {...p}
      style={(st) => [s.btn, { backgroundColor: bg }, kind === 'danger' && { borderWidth: 1, borderColor: t.c.danger }, kind === 'primary' && !disabled && t.elev.e1, st.pressed && { opacity: 0.85 }, style as object]}>
      <T v="button" tone={fg as Tone}>{title}</T>
    </Pressable>
  );
}

export function Chip({ label, onPress, kind = 'primary', a11y, selected }: { label: string; onPress?: () => void; kind?: 'primary' | 'ai' | 'neutral'; a11y?: string; selected?: boolean }) {
  const t = useTheme(); const s = useStyles();
  const bg = kind === 'ai' ? t.c.aiSoft : kind === 'neutral' && !selected ? t.c.surface : t.c.primarySoft;
  const fg: Tone = kind === 'ai' ? 'aiText' : kind === 'neutral' && !selected ? 'text2' : 'primaryText';
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={a11y ?? label} hitSlop={10} style={s.chipHit}>
      <View style={[s.chip, { backgroundColor: bg }, kind === 'neutral' && !selected && { borderWidth: 1, borderColor: t.c.line }]}>
        <T v="label" tone={fg}>{label}</T>
      </View>
    </Pressable>
  );
}

export function Badge({ label, kind }: { label: string; kind: 'ai' | 'brand' | 'accent' }) {
  const t = useTheme(); const s = useStyles();
  const bg = kind === 'ai' ? t.c.aiSoft : kind === 'accent' ? t.c.accentSoft : t.c.surface3;
  return <View style={[s.badge, { backgroundColor: bg }]}><T v="micro" tone={kind === 'ai' ? 'aiText' : kind === 'accent' ? 'accent' : 'text2'}>{label.toUpperCase()}</T></View>;
}

export function Field(p: TextInputProps & { label?: string }) {
  const t = useTheme(); const s = useStyles();
  return (
    <View style={{ gap: 4 }}>
      {p.label ? <T v="caption" tone="muted">{p.label}</T> : null}
      <TextInput placeholderTextColor={t.c.muted} {...p} style={[s.field, t.type.body, { color: t.c.text }, p.style]} />
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
            style={[s.segItem, on && { backgroundColor: t.dark ? t.c.primarySoft : t.c.surface, ...t.elev.e1 }]}>
            <T v="label" tone={on ? 'primaryText' : 'muted'}>{o.label}</T>
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
      <View style={[s.sheet, t.elev.e3]}>
        {title ? <T v="headline" style={{ marginBottom: 8 }}>{title}</T> : null}
        {children}
      </View>
    </Modal>
  );
}

/** Dark range popover ("170 kcal · range 140–210 · recipe estimate"). */
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
  screen: { flex: 1, backgroundColor: t.c.bg },
  pad: { padding: t.space.screen, gap: t.space.gap, paddingBottom: t.space.xxl },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: t.space.xs },
  card: { borderRadius: t.radius.card, paddingVertical: t.space.cardV, paddingHorizontal: t.space.cardH, gap: t.space.xs,
    borderWidth: t.dark ? 0 : 1, borderColor: t.c.line, ...t.elev.e1 },
  btn: { minHeight: t.sizes.touch, borderRadius: t.radius.button, alignItems: 'center', justifyContent: 'center', paddingHorizontal: t.space.md },
  chipHit: { minHeight: t.sizes.touch, justifyContent: 'center' },
  chip: { height: t.sizes.chip, borderRadius: t.radius.chip, paddingHorizontal: t.space.sm, justifyContent: 'center' },
  badge: { borderRadius: t.radius.full, paddingHorizontal: t.space.xs, paddingVertical: 2 },
  field: { minHeight: t.sizes.touch, borderRadius: t.radius.field, borderWidth: 1, borderColor: t.c.line, backgroundColor: t.c.surface, paddingHorizontal: t.space.sm },
  seg: { flexDirection: 'row', backgroundColor: t.c.surface3, borderRadius: t.radius.field, padding: 3 },
  segItem: { flex: 1, minHeight: 40, alignItems: 'center', justifyContent: 'center', borderRadius: t.radius.field - 3 },
  scrim: { flex: 1 },
  sheet: { backgroundColor: t.c.surface2, borderTopLeftRadius: t.radius.sheet, borderTopRightRadius: t.radius.sheet, padding: t.space.lg, gap: t.space.sm },
  popWrap: { flex: 1, justifyContent: 'center', padding: t.space.lg },
  pop: { borderRadius: t.radius.popover, padding: t.space.sm, gap: 2 },
}));
