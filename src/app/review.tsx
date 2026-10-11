import { useLocalSearchParams, useRouter } from 'expo-router';
import { ConfirmCard } from '@/components/ConfirmCard';
import { ItemCard } from '@/components/ItemEditor';
import { Button, Row, Screen, T } from '@/components/ui';
import { itemKind } from '@/lib/itemKind';
import { useStore } from '@/lib/store';

/** Review entries that resolved while you were away: same confirm UI as Log. Nothing here is counted until confirmed. */
export default function Review() {
  const st = useStore(); const router = useRouter();
  const { date } = useLocalSearchParams<{ date?: string }>();
  const rows = st.entries.filter((e) => e.needs_review && !e.deleted_at && e.review_item && (!date || e.local_date === date));
  return (
    <Screen title="To review" right={<Button kind="ghost" title="Done" onPress={() => router.back()} />}>
      {rows.length === 0 ? <T tone="muted">All checked.</T> : null}
      {rows.map((e) => {
        const it = e.review_item!;
        return itemKind(it) === 'ai_estimate' || !it.dish_id ? (
          <ItemCard key={e.id} it={it} slot={e.slot} confirmed={false} onEdit={(n) => st.confirmReview(e.id, n)} onConfirm={() => st.confirmReview(e.id, it)} onRemove={() => st.dropReview(e.id)} onSlot={() => {}} />
        ) : (
          <ConfirmCard key={e.id} it={it} onResolve={(n) => st.confirmReview(e.id, n)} onRemove={() => st.dropReview(e.id)} />
        );
      })}
      {rows.length ? (
        <Row><Button title={`✓ All look right · Add ${rows.reduce((a, e) => a + e.review_item!.kcal.best, 0)} kcal`} onPress={() => rows.forEach((e) => st.confirmReview(e.id, e.review_item!))} /></Row>
      ) : null}
    </Screen>
  );
}
