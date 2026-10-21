import { Pressable } from 'react-native';
import { T } from '@/components/ui';
import { useTheme } from '@/theme';

/** The one honey action (Save food / Save and add / Save); disabled = quiet surface, muted label. */
export function SaveButton({ title, onPress, disabled, a11y }: { title: string; onPress: () => void; disabled?: boolean; a11y: string }) {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} accessibilityLabel={a11y}
      style={{ height: 56, borderRadius: t.radius.button, alignItems: 'center', justifyContent: 'center',
        backgroundColor: disabled ? t.c.sheetTile : t.c.accentFill, borderWidth: disabled || t.dark ? 0 : 1.5, borderColor: t.c.honeyEdge }}>
      <T v="bodyStrong" style={{ fontSize: 17, color: disabled ? t.c.muted : t.c.onAccent }}>{title}</T>
    </Pressable>
  );
}
