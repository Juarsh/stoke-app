// Add exercise sheet (plan builder and the workout logger): the library's own search and ranking, first 40 matches.
import { useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { T } from '@/components/ui';
import type { Exercise, ExerciseRepo } from '@/lib/exercises';
import { useTheme } from '@/theme';
import { search } from '../library/model';

/** Add exercise: the library's own search (same ranking as Exercises), first 40 matches. */
export function ExercisePicker({ visible, repo, onClose, onPick }: { visible: boolean; repo: ExerciseRepo; onClose: () => void; onPick: (e: Exercise) => void }) {
  const t = useTheme(); const ins = useSafeAreaInsets();
  const [q, setQ] = useState('');
  const rows = useMemo(() => search(repo, q).slice(0, 40), [repo, q]);
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ height: 80, backgroundColor: t.c.scrim }} onPress={onClose} accessibilityLabel="Close" />
      <View style={{ flex: 1, backgroundColor: t.c.sheet, borderTopLeftRadius: t.radius.sheet, borderTopRightRadius: t.radius.sheet, paddingTop: 10, paddingBottom: ins.bottom }}>
        <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: t.c.handle, alignSelf: 'center', marginBottom: 10 }} />
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20 }}>
          <T v="title" accessibilityRole="header" style={{ fontSize: 22, flex: 1 }}>Add exercise</T>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center', marginRight: -10 }}>
            <Icon name="x" color={t.c.text} size={20} strokeWidth={2.2} />
          </Pressable>
        </View>
        <View style={{ marginHorizontal: 20, marginVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 14, borderWidth: 1.5, borderColor: t.c.cardLine, paddingHorizontal: 14, minHeight: 52 }}>
          <Icon name="search" color={t.c.text2} size={18} strokeWidth={2} />
          <TextInput value={q} onChangeText={setQ} placeholder={`Search ${repo.all().length} exercises`} placeholderTextColor={t.c.muted} accessibilityLabel="Search exercises"
            style={{ flex: 1, fontSize: 16, color: t.c.text, fontFamily: t.type.body.fontFamily }} selectionColor={t.c.em} autoCorrect={false} />
        </View>
        <FlatList data={rows} keyExtractor={(e) => e.id} keyboardShouldPersistTaps="handled"
          ListEmptyComponent={<T tone="text2" style={{ padding: 20 }}>No exercise matches “{q}”.</T>}
          renderItem={({ item: e }) => (
            <Pressable onPress={() => onPick(e)} accessibilityRole="button" accessibilityLabel={`Add ${e.name}, ${e.group}, ${e.equipment}`}
              style={({ pressed }) => ({ minHeight: 56, paddingHorizontal: 20, paddingVertical: 8, justifyContent: 'center', borderTopWidth: 1, borderTopColor: t.c.sheetLine, opacity: pressed ? 0.85 : 1 })}>
              <T v="bodyStrong" style={{ fontSize: 16 }}>{e.name}</T>
              <T tone="muted" style={{ fontSize: 14 }}>{e.group} · {e.equipment}</T>
            </Pressable>
          )} />
      </View>
    </Modal>
  );
}
