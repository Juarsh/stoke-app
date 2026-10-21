// Small shared pieces for the plan screens: the back header, a card, a confirm dialog (plan-builder-delete), a stepper.
import { useRouter } from 'expo-router';
import { Modal, Pressable, View, ViewProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { T } from '@/components/ui';
import { useTheme } from '@/theme';

export function Header({ title, right, close, onClose }: { title: string; right?: React.ReactNode; close?: boolean; onClose?: () => void }) {
  const t = useTheme(); const ins = useSafeAreaInsets(); const router = useRouter();
  return (
    <View style={{ paddingTop: ins.top + 6, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', minHeight: 56 + ins.top, gap: 8 }}>
      <Pressable onPress={onClose ?? (() => router.back())} accessibilityRole="button" accessibilityLabel={close ? 'Close' : 'Back'} style={{ width: 48, height: 48, marginLeft: -14, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={close ? 'x' : 'back'} color={t.c.text} size={22} strokeWidth={2.2} />
      </Pressable>
      <T v="headline" accessibilityRole="header" style={{ fontSize: 20, flex: 1 }} numberOfLines={2}>{title}</T>
      {right}
    </View>
  );
}
export function Box({ style, ...p }: ViewProps) {
  const t = useTheme();
  return <View {...p} style={[{ backgroundColor: t.c.card, borderRadius: t.radius.card, borderWidth: 1, borderColor: t.c.lineSoft, overflow: 'hidden' }, style]} />;
}
export function TextLink({ title, onPress, a11y, size = 15 }: { title: string; onPress: () => void; a11y?: string; size?: number }) {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={a11y ?? title} hitSlop={4} style={{ minHeight: 48, justifyContent: 'center', paddingHorizontal: 4 }}>
      <T v="bodyStrong" style={{ color: t.c.accentText, fontSize: size }}>{title}</T>
    </Pressable>
  );
}
export function HoneyButton({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => ({ minHeight: 56, borderRadius: 16, backgroundColor: t.c.accentFill, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.4 : pressed ? 0.85 : 1,
        ...(t.dark ? {} : { borderWidth: 1.5, borderColor: t.c.honeyEdge }) })}>
      <T v="button" style={{ color: t.c.onAccent, fontSize: 17 }}>{title}</T>
    </Pressable>
  );
}
export function Confirm({ visible, title, body, keep, drop, onKeep, onDrop }: { visible: boolean; title: string; body: string; keep: string; drop: string; onKeep: () => void; onDrop: () => void }) {
  const t = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onKeep}>
      <View style={{ flex: 1, backgroundColor: t.c.scrim, justifyContent: 'center', padding: 28 }}>
        <View accessibilityViewIsModal style={{ backgroundColor: t.c.sheet, borderRadius: 26, padding: 24, gap: 10, ...(t.dark ? { borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)' } : {}) }}>
          <T v="title" accessibilityRole="header" style={{ fontSize: 22 }}>{title}</T>
          <T tone="text2" style={{ fontSize: 15, lineHeight: 22 }}>{body}</T>
          <View style={{ marginTop: 8 }}><HoneyButton title={keep} onPress={onKeep} /></View>
          <Pressable onPress={onDrop} accessibilityRole="button" accessibilityLabel={drop} style={{ minHeight: 52, alignItems: 'center', justifyContent: 'center' }}>
            <T v="bodyStrong" style={{ fontSize: 16 }}>{drop}</T>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
/** − value + with 48dp targets; − / + are disabled at the limits (Q13 rule), never wrap or clamp silently. */
export function Stepper({ label, value, text, onStep, min, max }: { label: string; value: number; text?: string; onStep: (d: -1 | 1) => void; min: number; max: number }) {
  const t = useTheme();
  const btn = (d: -1 | 1) => {
    const off = d < 0 ? value <= min : value >= max;
    return (
      <Pressable onPress={() => onStep(d)} disabled={off} accessibilityRole="button" accessibilityLabel={`${d < 0 ? 'Less' : 'More'} ${label.toLowerCase()}`} accessibilityState={{ disabled: off }}
        style={{ width: 48, height: 48, borderRadius: 14, borderWidth: 1.5, borderColor: off ? t.c.lineSoft : t.c.cardLine, alignItems: 'center', justifyContent: 'center', opacity: off ? 0.5 : 1 }}>
        <Icon name={d < 0 ? 'minus' : 'plus'} color={t.c.text} size={18} strokeWidth={2.2} />
      </Pressable>
    );
  };
  return (
    <View style={{ gap: 4 }}>
      <T v="caption" tone="muted" style={{ fontSize: 13 }}>{label}</T>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }} accessible={false}>
        {btn(-1)}
        <T v="bodyStrong" style={{ fontSize: 17, minWidth: 38, textAlign: 'center' }} accessibilityLabel={`${label}: ${text ?? value}`}>{text ?? value}</T>
        {btn(1)}
      </View>
    </View>
  );
}
