import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ConfirmCard } from '@/components/ConfirmCard';
import { Glows } from '@/components/Gradient';
import { SlotCycle } from '@/components/ItemEditor';
import { DecisionCard, FailedAiRow, Group, ItemRow, OpenRow } from '@/components/LogRows';
import { aiStatus, failedCounts, FailedRow, failedRows, failedWaiting, lateAnswer, leaveLog, pollDelay } from '@/lib/aiRows';
import { ApiError, ParsePending } from '@/lib/api';
import { kindOf, plan, ServerItem } from '@/lib/confirmBatch';
import { Badge, Button, Card, Chip, Field, Row, T } from '@/components/ui';
import { entryFromItem, FoodEntry, localDate, Slot, slotFor } from '@/lib/domain';
import { AnyItem, isPlaceholder, itemKind } from '@/lib/itemKind';
import { PendingRow } from '@/components/PendingRow';
import { draftTotals, logSummary } from '@/lib/logSummary';
import { splitBySpan } from '@/lib/pending';
import { applyLearned, learnKey, LoggedItem, readingOf } from '@/lib/learned';
import { portionLabel, SLOT_LABEL } from '@/lib/labels';
import { parseLocal } from '@/lib/parseLocal';
import { useStore } from '@/lib/store';
import { config } from '@/lib/config';
import { DISH_TABLE_VERSION, Item } from '@/parser';
import { makeStyles } from '@/theme';

const AI_CAP = 20;
type Draft = { key: string; it: AnyItem & LoggedItem; ok: boolean; corrected?: boolean };
type Custom = FailedRow; // failed AI estimate (retry failed / busy / cap): the user's own kcal

export default function Log() {
  const st = useStore(); const router = useRouter(); const s = useStyles();
  const { prefill, slot: slotParam } = useLocalSearchParams<{ prefill?: string; slot?: Slot }>();
  const [text, setText] = useState('');
  const [slot, setSlot] = useState<Slot>(slotParam ?? slotFor(new Date()));
  const [slotAuto, setSlotAuto] = useState(true);
  const [edits, setEdits] = useState<Record<string, Item | null>>({});
  const [okd, setOkd] = useState<Record<string, boolean>>({});
  const [ai, setAi] = useState<Draft[]>([]);
  const [customs, setCustoms] = useState<Custom[]>([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (prefill) setText(String(prefill)); }, [prefill]);

  // Offline table parse on every keystroke (<100 ms).
  const parsed = useMemo(() => parseLocal(text), [text]);
  useEffect(() => { setEdits({}); setOkd({}); setAi([]); setCustoms([]); setMsg(''); }, [text]);
  // placeholders for unknown text are handled by the AI / custom-item flow below
  // remembered readings are applied first, so the same text never asks again
  const learnedItems = useMemo(() => applyLearned(parsed.items.filter((it) => !isPlaceholder(it)), st.learned), [parsed, st.learned]);
  const table: Draft[] = learnedItems
    .map((it, i) => ({ key: `t${i}`, it: (edits[`t${i}`] ?? it) as Draft['it'], ok: !!okd[`t${i}`] || !(edits[`t${i}`] ?? it).needs_confirmation, corrected: !!edits[`t${i}`] }))
    .filter((d) => edits[d.key] !== null);
  const drafts = [...table, ...ai];
  const pendingUnmatched = parsed.unmatched.filter((u) => !customs.some((c) => c.key === u) && !ai.some((a) => a.key.startsWith(`ai:${u}:`)));
  const aiUsedToday = st.aiUsed[localDate()] ?? 0;

  // AI-first: unknown spans go to the AI automatically (debounced, one batched call). Each span gets a STABLE id up front,
  // so a late answer (after Add / the 10 s timeout) fills the same review item instead of creating a new one.
  const [estimating, setEstimating] = useState<string[]>([]);
  const [offline, setOffline] = useState<string[]>([]);
  const spanIds = useRef(new Map<string, string>());
  const handedOff = useRef(new Set<string>()); // span ids already queued by Add
  const idFor = (u: string) => { let id = spanIds.current.get(u); if (!id) { id = st.newId(); spanIds.current.set(u, id); } return id; };
  const unk = pendingUnmatched.filter((u) => !estimating.includes(u) && !offline.includes(u));
  const unkKey = unk.join('|');
  useEffect(() => {
    if (!unk.length) return;
    const t = setTimeout(() => { estimateUnknown(unk); }, 600);
    return () => clearTimeout(t);
  }, [unkKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setEstimating([]); setOffline([]); }, [text]);

  // Driven by the server's ai_state (backend a72964e). The app never re-asks: a busy Gemini is requeued server-side and
  // the job stays "estimating", so we just keep polling GET /v1/parse/jobs/{id} until it is answered or failed.
  const gen = useRef(0);
  useEffect(() => { gen.current++; }, [text]); // text changed: stop polling for the old spans
  async function estimateUnknown(spans: string[]) {
    const myGen = gen.current;
    const toCustom = (us: string[], m: string, why: { reason?: string; userDailyLimit?: number; resetsAt?: string } = {}) => { setCustoms((c) => [...c, ...us.filter((u) => !c.some((x) => x.key === u)).map((u) => ({ key: u, id: idFor(u), name: u, kcal: '', protein: '', added: false, ...why }))]); setMsg(m); };
    if (aiUsedToday >= AI_CAP) return toCustom(spans, '', { reason: 'user_limit' });
    if (st.api.mock && !config.mockAi) return toCustom(spans, 'AI estimates need the server (this build is offline/mock). Add it yourself for now.');
    const ids = spans.map(idFor);
    setEstimating((e) => [...e, ...spans]); setBusy(true);
    const done = () => setEstimating((e) => e.filter((x) => !spans.includes(x)));
    // one handler for the first answer and for a late one (polled job): fills the SAME row by stable id
    const land = (r: Awaited<ReturnType<typeof st.api.parse>>) => {
      const status = aiStatus(r);
      if (status === 'estimating') return; // no job to poll on an inline answer: stays Estimating; Add / leaving hands it to review
      if (status === 'failed') {
        const why = { reason: r.fallback_reason ?? 'error', userDailyLimit: r.user_daily_limit, resetsAt: r.ai_resets_at };
        // every asked span gets a failed row (no AI kcal came for any of them), plus any extra open span the server listed
        const rows = failedRows(r, spans).filter((u) => !(spanIds.current.has(u) && handedOff.current.has(idFor(u)))); // handed-off spans stay needs_review
        toCustom(rows, '', why);
        done(); return;
      }
      const got = r.items.filter((x) => x.ai_estimate);
      spans.forEach((u, k) => {
        const its = splitBySpan(got, spans)[k];
        if (handedOff.current.has(ids[k])) { if (its.length) st.fillPending(ids[k], its); return; } // after Add / leaving: fills the review item, unconfirmed
        if (!its.length) { toCustom([u], '', { reason: r.fallback_reason ?? 'error', userDailyLimit: r.user_daily_limit, resetsAt: r.ai_resets_at }); return; }
        setCustoms((cs) => {
          const l = lateAnswer(cs.find((c) => c.key === u), its);
          if (l.drop) return cs; // the user's own kcal wins
          setAi((a) => a.some((x) => x.key.startsWith(`ai:${u}:${ids[k]}:`)) ? a : [...a, ...l.items.map((it, i) => ({ key: `ai:${u}:${ids[k]}:${i}`, it, ok: false }))]);
          return cs.filter((c) => c.key !== u);
        });
      });
      done();
    };
    const poll = async (p: ParsePending): Promise<void> => {
      let cur = p;
      for (;;) {
        await new Promise((res) => setTimeout(res, pollDelay(cur.nextAttemptAt)));
        if (gen.current !== myGen) return; // the text changed; handed-off spans are resolved by the sync queue
        try { land(await st.api.parseJob(cur.jobId)); return; }
        catch (e2) {
          if (e2 instanceof ParsePending) { cur = e2; continue; }
          if (e2 instanceof ApiError && (e2.status === 404 || e2.status === 410)) { // job lost (server restart / expired): offline pending
            done(); setOffline((o) => [...o, ...spans.filter((u) => !handedOff.current.has(idFor(u)))]); return;
          }
          cur = new ParsePending(cur.jobId); // network blip: keep the row Estimating and poll again
        }
      }
    };
    try {
      st.useAi();
      land(await st.api.parse(spans.join(', '), true));
    } catch (e) {
      if (e instanceof ParsePending) void poll(e);
      else {
        // network down: offline Pending (queued without a number on Add)
        done();
        setOffline((o) => [...o, ...spans.filter((u) => !handedOff.current.has(idFor(u)))]);
        setMsg('No connection. These stay pending and fill in when you’re back online.');
      }
    } finally { setBusy(false); }
  }

  // Confirm batch (design-notes v3.2 Oct 15): only confirmed rows, plain confident rows and server-marked one_tap_ok rows are
  // added/counted. Unit mismatches, AI estimates, estimate_unverified and other choices stay open and out of every total.
  const nEstimating = pendingUnmatched.filter((u) => !offline.includes(u)).length;
  const bp = plan(drafts.map((d) => ({ key: d.key, it: d.it as ServerItem, confirmed: d.ok })), nEstimating, failedWaiting(customs));
  const kindByKey = new Map(drafts.map((d) => [d.key, kindOf(d.it as ServerItem, d.ok)] as const));
  const addedCustoms = customs.filter(failedCounts); // failed rows count only once their kcal is added
  const { kcal: total, protein } = draftTotals(bp.add.map((r) => r.it), addedCustoms);
  // Offline Pending = '— kcal', not counted. Estimating = shimmer; Add stays enabled and sends them to items to review.
  const nPending = pendingUnmatched.length - nEstimating;
  const nOpen = bp.open.length;
  const sum0 = logSummary({ kcal: total, protein, items: bp.add.length + addedCustoms.length, estimating: nEstimating, pending: nPending,
    toConfirm: 0, estimates: 0, needsKcal: 0 });
  const openFailed = customs.length - addedCustoms.length;
  const sum = nOpen || openFailed || (nEstimating && bp.add.length) ? { ...sum0, total: bp.total, button: bp.button, soFar: !!nEstimating } : sum0;
  const any = drafts.length + customs.length + pendingUnmatched.length > 0;
  // Add stays enabled (Product): anything still open is saved as needs_review, never lost, never counted
  const canAdd = any && !(bp.disabled && bp.later); // confirm-none: primary disabled, 'Save · N to review later' is the way out
  const addLabel = sum.button;
  const listDrafts = drafts.filter((d) => ['counted', 'batch'].includes(kindByKey.get(d.key)!));
  const openDrafts = drafts.filter((d) => ['unit', 'estimate', 'unverified'].includes(kindByKey.get(d.key)!));
  const decisionDrafts = drafts.filter((d) => kindByKey.get(d.key) === 'choice');

  function add(leave = false) {
    const date = localDate();
    // uncertain or corrected readings carry their span, so the server remembers them (Remembered foods)
    const learn = (d: Draft) => (!d.ok || d.corrected || d.it.source !== 'table') && !d.it.remembered && !d.it.learned;
    const adding = drafts.filter((d) => bp.add.some((r) => r.key === d.key));
    const es: FoodEntry[] = adding.map((d) => entryFromItem({ ...d.it, needs_confirmation: false }, { id: st.newId(), slot, raw_text: text, local_date: date, tableVersion: DISH_TABLE_VERSION, remember: learn(d) }));
    // offline ones wait as Pending; estimating ones go straight to items to review (at: 0), keyed by their stable id
    if (pendingUnmatched.length) st.addPending(pendingUnmatched.map((span) => {
      const id = idFor(span); handedOff.current.add(id);
      return { id, span, slot, local_date: date, raw_text: text, ...(offline.includes(span) ? {} : { at: 0 }) };
    }));
    for (const c of addedCustoms) {
      const k = Number(c.kcal) || 0, p = Number(c.protein) || 0, now = new Date().toISOString();
      es.push({ id: st.newId(), local_date: date, slot, raw_text: text, dish_id: null, custom_name: c.name, qty: 1, unit: 'count', oil_level: '',
        kcal: { low: k, best: k, high: k }, protein_g: { low: p, best: p, high: p }, source: 'custom', source_note: 'Your entry',
        confirmed: true, dish_table_version: DISH_TABLE_VERSION, created_at: now, updated_at: now, deleted_at: null });
    }
    st.addEntries(es);
    // remember every reading the user confirmed or corrected (table items with a known dish only)
    st.remember(adding.filter((d) => learn(d) && d.it.dish_id && !d.it.ai_estimate)
      .map((d) => [learnKey(d.it.matched_text), readingOf(d.it)] as [string, ReturnType<typeof readingOf>]));
    if (!leave && (nOpen || openFailed) && adding.length + addedCustoms.length > 0) { // open rows stay on screen with their own controls; the rest is saved
      for (const d of adding) remove(d);
      setCustoms((cs) => cs.filter((c) => !failedCounts(c)));
      setMsg(bp.note);
      return;
    }
    if (nOpen || openFailed) saveOpen(); // nothing addable: open items go to review (Add stays enabled)
    setText('');
    router.navigate('/');
  }
  /** Open items -> needs_review entries (streak yes, calories no, never lost). Used by Add-with-nothing-addable and on leaving Log. */
  function saveOpen() {
    const open = drafts.filter((d) => !bp.add.some((r) => r.key === d.key));
    const est = pendingUnmatched.filter((u) => !offline.includes(u) && !handedOff.current.has(idFor(u)));
    const failed = customs.filter((c) => !failedCounts(c));
    if (!open.length && !failed.length && !est.length) return false;
    const { reviews, pending } = leaveLog({ open: open.map((d) => d.it), failed, estimating: est.map((u) => ({ id: idFor(u), span: u })), slot, text, date: localDate(), newId: st.newId });
    for (const f of failed) handedOff.current.add(f.id);
    for (const p of pending) handedOff.current.add(p.id);
    if (reviews.length) st.addEntries(reviews);
    if (pending.length) st.addPending(pending);
    return true;
  }
  const leaveRef = useRef(saveOpen); leaveRef.current = saveOpen;
  useFocusEffect(useCallback(() => () => { if (leaveRef.current()) setText(''); }, []));
  const setItem = (d: Draft, n: Item) => d.key.startsWith('ai:') ? setAi((a) => a.map((x) => (x.key === d.key ? { ...x, it: n } : x))) : setEdits((e) => ({ ...e, [d.key]: n }));
  const remove = (d: Draft) => d.key.startsWith('ai:') ? setAi((a) => a.filter((x) => x.key !== d.key)) : setEdits((e) => ({ ...e, [d.key]: null }));
  const confirm = (d: Draft) => d.key.startsWith('ai:') ? setAi((a) => a.map((x) => (x.key === d.key ? { ...x, ok: true } : x))) : setOkd((o) => ({ ...o, [d.key]: true }));

  return (
    <View style={{ flex: 1 }}>
      <Glows />
      <SafeAreaView edges={['top']} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
          <Row style={{ justifyContent: 'space-between' }}>
            <T v="title">What did you eat?</T>
            <T v="caption" tone="muted" onPress={() => { setSlot(SlotCycle(slot)); setSlotAuto(false); }} accessibilityRole="button" accessibilityLabel={`Meal slot ${SLOT_LABEL[slot]}, double-tap to change`} style={{ padding: 12 }}>{`${SLOT_LABEL[slot]}${slotAuto ? ' · auto' : ''} ✎`}</T>
          </Row>
          <Field big value={text} onChangeText={setText} multiline numberOfLines={1} placeholder="e.g. 2 roti, dal, thoda ghee" accessibilityLabel="What did you eat?" autoCorrect={false} />
          {listDrafts.length ? (
            <Group>
              {listDrafts.map((d) => (
                <ItemRow key={d.key} it={d.it} state={d.it.remembered || d.it.learned ? 'remembered' : d.it.ai_estimate ? 'estimate' : 'plain'}
                  tableMatch={kindByKey.get(d.key) === 'batch'} onEdit={(n) => setItem(d, n)} onRemove={() => remove(d)} />
              ))}
            </Group>
          ) : null}
          {openDrafts.length ? (
            <Group>
              {openDrafts.map((d) => (
                <OpenRow key={d.key} it={d.it} kind={kindByKey.get(d.key) as 'unit' | 'estimate' | 'unverified'}
                  onConfirm={(n) => { setItem(d, n); confirm(d); }} onEdit={(n) => setItem(d, n)} onRemove={() => remove(d)} />
              ))}
            </Group>
          ) : null}
          {decisionDrafts.map((d) => (
            <DecisionCard key={d.key} it={d.it} onPick={(x) => { setItem(d, x); confirm(d); }} onEdit={(n) => setItem(d, n)} onRemove={() => remove(d)} />
          ))}
          {pendingUnmatched.length ? (
            <Group>
              {pendingUnmatched.map((u) => <PendingRow key={u} tile label={u} sub="read from your text" state={offline.includes(u) ? 'offline' : 'estimating'} />)}
            </Group>
          ) : null}
          {nEstimating ? <T v="caption" tone="muted">Estimates usually take 1–2 seconds.</T> : nPending ? <T v="caption" tone="muted">{msg}</T> : null}
          {customs.length ? (
            <Group>
              {customs.map((c) => (
                <FailedAiRow key={c.key} row={c} onKcal={(v) => setCustoms((cs) => cs.map((x) => (x.key === c.key ? { ...x, kcal: v } : x)))}
                  onAdd={() => setCustoms((cs) => cs.map((x) => (x.key === c.key ? { ...x, added: true } : x)))} />
              ))}
            </Group>
          ) : null}
        </ScrollView>
        {any ? (
          <View style={s.dock}>
            <Row style={{ justifyContent: 'space-between' }}>
              <T v="caption" tone="muted">{sum.total}</T>
              <T v="number">{sum.kcalText} <T v="caption" tone="muted">{sum.soFar ? 'kcal so far' : `kcal · ${sum.protein} g`}</T></T>
            </Row>
            <Button title={addLabel} disabled={!canAdd} onPress={() => add()} accessibilityLabel={addLabel} />
            {bp.later ? <Button kind="outline" title={bp.later} onPress={() => add(true)} accessibilityLabel={bp.later} /> : null}
            {nOpen && bp.add.length ? <T v="caption" tone="muted" style={{ textAlign: 'center' }}>{bp.note}</T> : null}
          </View>
        ) : null}
      </SafeAreaView>
    </View>
  );
}
const useStyles = makeStyles((t) => ({
  pad: { padding: t.space.screen, gap: t.space.gap, paddingBottom: t.sizes.nav + 140 },
  dock: { position: 'absolute', left: 0, right: 0, bottom: t.sizes.nav + 16, gap: 8, paddingHorizontal: t.space.md, paddingTop: 10, paddingBottom: 12, backgroundColor: t.c.bg, borderTopWidth: 1, borderTopColor: t.c.line },
  pill: { paddingVertical: 10, borderRadius: t.radius.full },
}));
