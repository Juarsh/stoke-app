import { useRouter } from 'expo-router';
import { Modal, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { T } from '@/components/ui';
import { useTheme } from '@/theme';

type Row = { key: string; title: string; sub?: string; icon: string; tint?: 'food' | 'train' | 'honey'; to?: string };
/** + sheet rows in spec order (§2 + CEO Q1/Q26): Log food, Add habit, Start workout, Ask Coach, Start an empty workout.
 * Log weight is hidden in v1 (Q1). Rows without a route are stubs until their build-plan item lands. */
const ROWS: Row[] = [
  { key: 'food', title: 'Log food', icon: 'food', tint: 'food', to: '/log' },
  { key: 'habit', title: 'Add habit', sub: 'Yes / no, a count, or sets', icon: 'habit', tint: 'train' },
  { key: 'workout', title: 'Start workout', icon: 'train', tint: 'train' },
  { key: 'coach', title: 'Ask Coach', sub: 'Food and training questions', icon: 'spark', tint: 'honey', to: '/coach' },
  { key: 'empty', title: 'Start an empty workout', icon: 'plus' },
];

export function PlusSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const t = useTheme(); const ins = useSafeAreaInsets(); const router = useRouter();
  const tint = (k?: Row['tint']) => k === 'food' ? t.c.foodText : k === 'train' ? t.c.trainText : k === 'honey' ? t.c.accentText : t.c.text2;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: t.c.scrim }} onPress={onClose} accessibilityLabel="Close" />
      <View accessibilityRole="none" accessibilityLabel="Add" style={{ backgroundColor: t.c.sheet, borderTopLeftRadius: t.radius.sheet, borderTopRightRadius: t.radius.sheet,
        paddingHorizontal: 20, paddingTop: 10, paddingBottom: 28 + ins.bottom, ...(t.dark ? { borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)' } : {}) }}>
        <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: t.c.handle, alignSelf: 'center', marginBottom: 16 }} />
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <T v="title" style={{ fontSize: 22 }} accessibilityRole="header">Add</T>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center', marginRight: -10 }}>
            <Icon name="x" color={t.c.text} size={20} strokeWidth={2.2} />
          </Pressable>
        </View>
        <View style={{ marginTop: 10, borderWidth: 1, borderColor: t.c.sheetLine, borderRadius: t.radius.card, overflow: 'hidden' }}>
          {ROWS.map((r, i) => {
            const stub = !r.to;
            const sub = stub ? 'Coming in a later build' : r.sub;
            return (
              <Pressable key={r.key} disabled={stub} accessibilityRole="button" accessibilityState={{ disabled: stub }} accessibilityLabel={sub ? `${r.title}, ${sub}` : r.title}
                onPress={() => { onClose(); if (r.to) router.push(r.to as never); }}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 14, minHeight: sub ? 64 : 52,
                  borderTopWidth: i ? 1 : 0, borderTopColor: t.c.sheetLine, opacity: stub ? 0.6 : 1 }}>
                <View style={{ width: 36, height: 36, borderRadius: 11, backgroundColor: t.c.sheetTile, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name={r.icon} color={tint(r.tint)} size={20} />
                </View>
                <View style={{ flex: 1 }}>
                  <T v="bodyStrong" style={{ fontSize: 15 }}>{r.title}</T>
                  {sub ? <T v="caption" tone="muted" style={{ fontSize: 13 }}>{sub}</T> : null}
                </View>
                <Icon name="chev" color={t.c.muted} size={18} strokeWidth={2.2} />
              </Pressable>
            );
          })}
        </View>
      </View>
    </Modal>
  );
}
