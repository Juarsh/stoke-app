import { useRouter } from 'expo-router';
import { Alert } from 'react-native';
import { Button, Card, Row, Screen, T } from '@/components/ui';
import { portionLabel } from '@/lib/labels';
import { useStore } from '@/lib/store';

/** Settings › Remembered foods: "text → reading" with per-row Reset and Reset all. */
export default function Remembered() {
  const st = useStore(); const router = useRouter();
  const rows = Object.entries(st.learned).sort((a, b) => b[1].at.localeCompare(a[1].at));
  return (
    <Screen title="Remembered foods" right={<Button kind="ghost" title="Done" onPress={() => router.back()} />}>
      <T tone="muted">When you confirm or correct a reading, we use it next time and don’t ask again.</T>
      {rows.length === 0 ? <Card><T tone="muted">Nothing remembered yet.</T></Card> : null}
      {rows.map(([text, r]) => (
        <Card key={text}>
          <Row style={{ justifyContent: 'space-between' }}>
            <T style={{ flex: 1 }}><T v="bodyStrong">“{text}”</T><T tone="text2"> → {r.name} · {portionLabel(r.qty, r.unit)}{r.oil_level ? ` · oil ${r.oil_level}` : ''}{r.uses ? ` · used ${r.uses}×` : ''}</T></T>
            <Button kind="ghost" title="Reset" accessibilityLabel={`Reset ${text}`} onPress={() => st.forget(text)} />
          </Row>
        </Card>
      ))}
      {rows.length ? <Button kind="danger" title="Reset all" onPress={() => Alert.alert('Reset all remembered foods?', 'We’ll ask again next time.', [
        { text: 'Cancel', style: 'cancel' }, { text: 'Reset all', style: 'destructive', onPress: () => st.forget() }])} /> : null}
    </Screen>
  );
}
