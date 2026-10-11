import { useLocalSearchParams, useRouter } from 'expo-router';
import { ConfirmCard } from '@/components/ConfirmCard';
import { ItemCard } from '@/components/ItemEditor';
import { PendingRow } from '@/components/PendingRow';
import { Button, Card, Row, Screen, T } from '@/components/ui';
import { toReview } from '@/lib/domain';
import { itemKind } from '@/lib/itemKind';
import { reviewHeader } from '@/lib/reviewMode';
import { useStore } from '@/lib/store';
import { isStale, pendingFor } from '@/lib/syncQueue';

/** Items to review: uncertain resolutions (same confirm UI as Log) + foods still waiting on an estimate after ~10 s.
 * Nothing here is counted until confirmed. */
export default function Review() {
  const st = useStore(); const router = useRouter();
  const { date } = useLocalSearchParams<{ date?: string }>();
  const rows = st.entries.filter((e) => toReview(e) && (!date || e.local_date === date));
  const waiting = pendingFor(st.queue, date).filter((f) => isStale(f));
  const mode = reviewHeader(rows.map((e) => e.review_item!));
  const kcal = rows.reduce((a, e) => a + e.review_item!.kcal.best, 0).toLocaleString('en-IN');
  return (
    <Screen title="To review" right={<Button kind="ghost" title="Done" onPress={() => router.back()} />}>
      {rows.length === 0 && waiting.length === 0 ? <T tone="muted">All checked.</T> : null}
      {mode.allEstimates ? <T tone="text2">AI estimates · tap any to adjust</T> : null}
      {rows.map((e) => {
        const it = e.review_item!;
        return itemKind(it) === 'ai_estimate' || !it.dish_id ? (
          <ItemCard key={e.id} it={it} slot={e.slot} confirmed={false} plain={mode.allEstimates} onEdit={(n) => st.confirmReview(e.id, n)}
            onConfirm={() => st.confirmReview(e.id, it)} onRemove={() => st.dropReview(e.id)} onSlot={() => {}} />
        ) : (
          <ConfirmCard key={e.id} it={it} onResolve={(n) => st.confirmReview(e.id, n)} onRemove={() => st.dropReview(e.id)} />
        );
      })}
      {waiting.length ? (
        <Card>
          {waiting.map((f) => <PendingRow key={f.id} label={f.span} state="offline" />)}
          <T v="caption" tone="muted">Still waiting for an estimate. These fill in here when it arrives.</T>
        </Card>
      ) : null}
      {rows.length ? (
        <Row><Button title={mode.allEstimates ? `Confirm & add ${kcal} kcal` : `✓ All look right · Add ${kcal} kcal`}
          onPress={() => rows.forEach((e) => st.confirmReview(e.id, e.review_item!))} /></Row>
      ) : null}
    </Screen>
  );
}
