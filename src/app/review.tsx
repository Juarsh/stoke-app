import { useLocalSearchParams, useRouter } from 'expo-router';
import { ConfirmCard } from '@/components/ConfirmCard';
import { ItemCard } from '@/components/ItemEditor';
import { OpenRow } from '@/components/LogRows';
import { rejectCopy } from '@/lib/confirmBatch';
import { PendingRow } from '@/components/PendingRow';
import { Button, Card, Row, Screen, T } from '@/components/ui';
import { hasKcal, toReview } from '@/lib/domain';
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
  // rows the server refused never join the bulk confirm: each needs its own fix
  const bulk = rows.filter((e) => !e.reject_code && hasKcal(e.review_item));
  const mode = reviewHeader(rows.map((e) => e.review_item!));
  const kcal = bulk.reduce((a, e) => a + e.review_item!.kcal.best, 0).toLocaleString('en-IN');
  return (
    <Screen title="To review" right={<Button kind="ghost" title="Done" onPress={() => router.back()} />}>
      {rows.length === 0 && waiting.length === 0 ? <T tone="muted">All checked.</T> : null}
      {mode.allEstimates ? <T tone="text2">AI estimates · tap any to adjust</T> : null}
      {rows.map((e) => {
        const it = e.review_item!;
        if (!hasKcal(it)) {
          // no number yet: never shown or confirmable as 0 kcal
          return (
            <Card key={e.id}>
              <Row style={{ justifyContent: 'space-between' }}>
                <T v="bodyStrong" style={{ flex: 1 }}>{e.raw_text || it.name}</T>
                <T tone="muted">— kcal · needs review</T>
              </Row>
              {e.reject_code ? <T v="caption" tone="muted">{rejectCopy(e.reject_code)}</T> : null}
              <Row><Button kind="ghost" title="Remove" onPress={() => st.dropReview(e.id)} /></Row>
            </Card>
          );
        }
        if (e.reject_code) {
          const chips = (e.reject_code === 'variant_required' && (it.flags ?? []).includes('variant_choice') && !!(it as { variant_options?: unknown[] }).variant_options?.length)
            || e.reject_code === 'quantity_required';
          return (
            <Card key={e.id}>
              <T v="caption" tone="muted">You typed: {e.raw_text}</T>
              {chips
                ? <OpenRow it={it} kind="unit" text={e.raw_text} onConfirm={(n) => st.confirmReview(e.id, n)} onEdit={(n) => st.confirmReview(e.id, n)} onRemove={() => st.dropReview(e.id)} />
                : <ItemCard it={it} slot={e.slot} confirmed={false} onEdit={(n) => st.confirmReview(e.id, n)} onConfirm={() => st.confirmReview(e.id, it)} onRemove={() => st.dropReview(e.id)} onSlot={() => {}} />}
              <T v="caption" tone="muted">{rejectCopy(e.reject_code)}</T>
            </Card>
          );
        }
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
      {bulk.length ? (
        <Row><Button title={mode.allEstimates ? `Confirm & add ${kcal} kcal` : `✓ All look right · Add ${kcal} kcal`}
          onPress={() => bulk.forEach((e) => st.confirmReview(e.id, e.review_item!))} /></Row>
      ) : null}
    </Screen>
  );
}
