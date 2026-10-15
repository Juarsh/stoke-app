import { useRouter } from 'expo-router';
import { Alert, View } from 'react-native';
import { Button, Card, Row, Screen, T } from '@/components/ui';
import { portionLabel } from '@/lib/labels';
import { useStore } from '@/lib/store';
import { useTheme } from '@/theme';

/** Settings › Remembered foods: "text → reading" with per-row Reset and Reset all. */
export default function Remembered() {
  const st = useStore(); const router = useRouter(); const t = useTheme();
  const rows = Object.entries(st.learned).sort((a, b) => b[1].at.localeCompare(a[1].at));
  return (
    <Screen title="Remembered foods" right={<Button kind="ghost" title="Done" onPress={() => router.back()} />}>
      <T tone="muted">When you confirm or correct how something was read, we remember it and stop asking.</T>
      {rows.length === 0 ? <Card><T tone="muted">Nothing remembered yet.</T></Card> : (
        <Card style={{ paddingVertical: 4 }}>
          {rows.map(([text, r], i) => (
            <Row key={text} style={[{ justifyContent: 'space-between', minHeight: 56, paddingVertical: 8 }, i > 0 && { borderTopWidth: 1, borderTopColor: t.c.line }]}>
              <View style={{ flex: 1 }}>
                <T v="bodyStrong" numberOfLines={1}>“{text}”</T>
                <T v="caption" tone="text2" numberOfLines={1}>→ {r.name} · {portionLabel(r.qty, r.unit)}{r.oil_level && r.oil_level !== 'normal' ? ` · oil ${r.oil_level}` : ''}</T>
              </View>
              <T v="bodyStrong" tone="em" accessibilityRole="button" accessibilityLabel={`Reset ${text}`} onPress={() => st.forget(text)} style={{ padding: 12 }}>Reset</T>
            </Row>
          ))}
        </Card>
      )}
      {rows.length ? (
        <T v="bodyStrong" tone="text2" accessibilityRole="button" style={{ textAlign: 'center', padding: 12 }} onPress={() => Alert.alert('Reset all remembered foods?', 'We’ll ask again next time.', [
          { text: 'Cancel', style: 'cancel' }, { text: 'Reset all', style: 'destructive', onPress: () => st.forget() }])}>↺ Reset all remembered foods</T>
      ) : null}
    </Screen>
  );
}
