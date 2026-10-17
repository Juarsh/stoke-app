import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { ConfirmCard } from '@/components/ConfirmCard';
import { ItemCard } from '@/components/ItemEditor';
import { OpenRow } from '@/components/LogRows';
import { reviewRowKind, reviewSummary } from '@/lib/confirmBatch';
import { KcalRow } from '@/components/KcalRow';
import { rejectCopy } from '@/lib/confirmBatch';
import { PendingRow } from '@/components/PendingRow';
import { Button, Card, Row, Screen, T } from '@/components/ui';
import { hasKcal, toReview } from '@/lib/domain';
import { itemKind } from '@/lib/itemKind';
import { reviewHeader } from '@/lib/reviewMode';
import { CHOOSE_FIRST_REASON, useStore } from '@/lib/store';
import type { Item } from '@/parser';
import { isStale, pendingFor } from '@/lib/syncQueue';
import { failedCopy } from '@/lib/aiRows';
import { useBackstopTick } from '@/lib/useBackstop';

/** Items to review: uncertain resolutions (same confirm UI as Log) + foods still waiting on an estimate after ~10 s.
 * Nothing here is counted until confirmed. */
export default function Review() {
  const st = useStore(); const router = useRouter();
  const { date } = useLocalSearchParams<{ date?: string }>();
  useBackstopTick(st.expireAi); // 35-minute AI backstop while this screen is open
  const rows = st.entries.filter((e) => toReview(e) && (!date || e.local_date === date));
  const waiting = pendingFor(st.queue, date).filter((f) => isStale(f));
  // rows the server refused never join the bulk confirm: each needs its own fix
  const sum = reviewSummary(rows); // the one bulk rule (confirmBatch.bulkEligible, same as Log)
  const mode = reviewHeader(rows.map((e) => e.review_item!));
  /** entry id -> why the store guard refused the save: the row stays here with it (never dropped silently) */
  const [no, setNo] = useState<Record<string, string>>({});
  const tried = (id: string, why: string | null | void) => setNo((m) => ({ ...m, [id]: why || '' }));
  /** entry id -> the reading that still needs a pick: its choices are shown (the message never points to a hidden one) */
  const [choice, setChoice] = useState<Record<string, Item>>({});
  const confirmIt = (id: string, n: Item) => {
    const why = st.confirmReview(id, n);
    setChoice((m) => { const c = { ...m }; if (why === CHOOSE_FIRST_REASON) c[id] = n; else delete c[id]; return c; });
    tried(id, why);
  };
  return (
    <Screen title="To review" right={<Button kind="ghost" title="Done" onPress={() => router.back()} />}>
      {rows.length === 0 && waiting.length === 0 ? <T tone="muted">All checked.</T> : null}
      {mode.allEstimates ? <T tone="text2">AI estimates · tap any to adjust</T> : null}
      {rows.map((e) => {
        const it = e.review_item!;
        const kind = reviewRowKind(it);
        const body = choice[e.id]
          ? <OpenRow it={choice[e.id]} kind="unit" text={e.raw_text} onConfirm={(n) => confirmIt(e.id, n)} onEdit={(n) => confirmIt(e.id, n)} onRemove={() => st.dropReview(e.id)} />
          : kind === 'kcal'
          ? <KcalRow name={e.raw_text || it.name} note={e.ai_fail_reason ? failedCopy({ reason: e.ai_fail_reason, resetsAt: e.ai_resets_at }) : undefined} onAdd={(k) => tried(e.id, st.confirmReviewKcal(e.id, k))} onRemove={() => st.dropReview(e.id)} />
          : kind === 'estimate'
            ? <OpenRow it={it} kind="estimate" text={e.raw_text} onAdd={(n) => confirmIt(e.id, n)} onConfirm={(n) => confirmIt(e.id, n)} onEdit={(n) => confirmIt(e.id, n)} onRemove={() => st.dropReview(e.id)} />
          : kind === 'chips'
            ? <OpenRow it={it} kind="unit" text={e.raw_text} onConfirm={(n) => confirmIt(e.id, n)} onEdit={(n) => confirmIt(e.id, n)} onRemove={() => st.dropReview(e.id)} />
            : itemKind(it) === 'ai_estimate' || !it.dish_id
              ? <ItemCard it={it} slot={e.slot} confirmed={false} onEdit={(n) => confirmIt(e.id, n)} onConfirm={() => confirmIt(e.id, it)} onRemove={() => st.dropReview(e.id)} onSlot={() => {}} />
              : <ConfirmCard it={it} onResolve={(n) => confirmIt(e.id, n)} onRemove={() => st.dropReview(e.id)} />;
        return (
          <Card key={e.id}>
            {e.reject_code ? <T v="caption" tone="muted">You typed: {e.raw_text}</T> : null}
            {body}
            {e.reject_code ? <T v="caption" tone="muted">{rejectCopy(e.reject_code)}</T> : null}
            {no[e.id] ? <T v="caption" tone="warn" accessibilityLiveRegion="polite" testID="refusal">Not saved: {no[e.id]}</T> : null}
          </Card>
        );
      })}
      {waiting.length ? (
        <Card>
          {waiting.map((f) => <PendingRow key={f.id} label={f.span} state="offline" />)}
          <T v="caption" tone="muted">Still waiting for an estimate. These fill in here when it arrives.</T>
        </Card>
      ) : null}
      {sum.stillText ? <T tone="muted">{sum.stillText}</T> : null}
      {sum.button ? (
        <Row><Button title={sum.button} onPress={() => sum.bulk.forEach((e) => confirmIt(e.id, e.review_item!))} /></Row>
      ) : null}
    </Screen>
  );
}
