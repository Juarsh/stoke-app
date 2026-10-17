// Review row with no real number (failed AI / placeholder): '— kcal · needs review' until the user types kcal.
import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { AddButton, Button, Row, T } from '@/components/ui';
import { useTheme } from '@/theme';

/** note: the failed-AI copy (failedCopy) shown above the kcal field, e.g. the 35-minute backstop's. */
export function KcalRow({ name, note, onAdd, onRemove }: { name: string; note?: string; onAdd: (kcal: number) => void; onRemove: () => void }) {
  const t = useTheme(); const [v, setV] = useState('');
  const k = Number(v);
  const ok = Number.isFinite(k) && k > 0 && k <= 5000;
  return (
    <View style={{ gap: 8 }}>
      <Row style={{ justifyContent: 'space-between' }}>
        <T v="bodyStrong" style={{ flex: 1 }}>{name}</T>
        <T tone="muted">— kcal · needs review</T>
      </Row>
      {note ? <T tone="text2">{note}</T> : null}
      <T tone="text2">Enter kcal</T>
      <Row style={{ gap: 8 }}>
        <TextInput value={v} onChangeText={(x) => setV(x.replace(/[^0-9]/g, '').slice(0, 4))} keyboardType="number-pad" placeholder="kcal" placeholderTextColor={t.c.muted}
          accessibilityLabel={`Calories for ${name}`} style={[t.type.body, { flex: 1, minHeight: 44, borderWidth: 1, borderColor: t.c.muted, borderRadius: 12, paddingHorizontal: 12, color: t.c.text }]} />
        {/* disabled (40%) until a valid number is typed */}
        <AddButton onPress={() => ok && onAdd(k)} disabled={!ok} accessibilityLabel={`Add ${name}`} />
      </Row>
      <Row><Button kind="ghost" title="Remove" onPress={onRemove} /></Row>
    </View>
  );
}
