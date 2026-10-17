import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ConfirmCard } from '@/components/ConfirmCard';
import { Glows } from '@/components/Gradient';
import { SlotCycle } from '@/components/ItemEditor';
import { DecisionCard, FailedAiRow, Group, ItemRow, OpenRow } from '@/components/LogRows';
import { aiStatus, failedCounts, failReason, FailedRow, failedRows, failedWaiting, lateAnswer, leaveLog, pollDelay, resetOf } from '@/lib/aiRows';
import { localCapHit } from '@/lib/aiQuota';
import { ApiError, ParsePending } from '@/lib/api';
import { canAddEstimate, kindOf, plan, ServerItem } from '@/lib/confirmBatch';
import { Badge, Button, Card, Chip, Field, Row, T } from '@/components/ui';
import { entryFromItem, entryRefusal, FoodEntry, localDate, Slot, slotFor } from '@/lib/domain';
import { AnyItem, isPlaceholder, itemKind } from '@/lib/itemKind';
import { PendingRow } from '@/components/PendingRow';
import { backstopDue, BACKSTOP_REASON, isExpiredId } from '@/lib/aiBackstop';
import { useBackstopTick } from '@/lib/useBackstop';
import { draftTotals, logSummary } from '@/lib/logSummary';
import { splitBySpan } from '@/lib/pending';
import { applyLearned, learnKey, LoggedItem, readingOf } from '@/lib/learned';
import { portionLabel, SLOT_LABEL } from '@/lib/labels';
import { parseLocal } from '@/lib/parseLocal';
import { useStore } from '@/lib/store';
import { config } from '@/lib/config';
import { DISH_TABLE_VERSION, Item } from '@/parser';
import { makeStyles } from '@/theme';

/** per-user AI estimates a day (CEO: 3 for the closed test; matches the server's AI_USER_DAILY_CAP default) */
const AI_CAP = 3;
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
  /** rows the store guard refused (draft / custom key -> why): they stay open on screen with the reason, never dropped */
  const [refused, setRefused] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (prefill) setText(String(prefill)); }, [prefill]);

  // Offline table parse on every keystroke (<100 ms).
  const parsed = useMemo(() => parseLocal(text), [text]);
  useEffect(() => { setEdits({}); setOkd({}); setAi([]); setCustoms([]); setMsg(''); setRefused({}); }, [text]);
  // placeholders for unknown text are handled by the AI / custom-item flow below
  // remembered readings are applied first, so the same text never asks again
  const learnedItems = useMemo(() => applyLearned(parsed.items.filter((it) => !isPlaceholder(it)), st.learned), [parsed, st.learned]);
  const table: Draft[] = learnedItems
    .map((it, i) => ({ key: `t${i}`, it: (edits[`t${i}`] ?? it) as Draft['it'], ok: !!okd[`t${i}`] || !(edits[`t${i}`] ?? it).needs_confirmation, corrected: !!edits[`t${i}`] }))
    .filter((d) => edits[d.key] !== null);
  const drafts = [...table, ...ai];
  const pendingUnmatched = parsed.unmatched.filter((u) => !customs.some((c) => c.key === u) && !ai.some((a) => a.key.startsWith(`ai:${u}:`)));

  // AI-first: unknown spans go to the AI automatically (debounced, one batched call). Each span gets a STABLE id up front,
  // so a late answer (after Add / the 10 s timeout) fills the same review item instead of creating a new one.
  const [estimating, setEstimating] = useState<string[]>([]);
  const [offline, setOffline] = useState<string[]>([]);
  const spanIds = useRef(new Map<string, string>());
  const handedOff = useRef(new Set<string>()); // span ids already queued by Add
  // 35-minute backstop (aiBackstop): when each span's AI job started, and the span ids it already turned into failed rows
  const estStart = useRef(new Map<string, number>());
  const expired = useRef(new Set<string>());
  // server job -> its span ids, and span id -> job: a job whose spans were all converted by the backstop is abandoned once;
  // AI readings saved from a polled job carry its id (parse_job_id)
  const jobSpans = useRef(new Map<string, string[]>());
  const jobOf = useRef(new Map<string, string>());
  const abandoned = useRef(new Set<string>());
  const entriesRef = useRef(st.entries); entriesRef.current = st.entries;
  const gone = (id: string) => expired.current.has(id) || isExpiredId(entriesRef.current, id);
  const abandonIfGone = (jobId: string) => {
    const ids = jobSpans.current.get(jobId);
    if (!ids || abandoned.current.has(jobId) || !ids.every(gone)) return;
    abandoned.current.add(jobId); st.abandonJob(jobId);
  };
  const jobFor = (d: Draft) => { const p = d.key.split(':'); return d.key.startsWith('ai:') ? jobOf.current.get(p[p.length - 2]) : undefined; };
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
    // the app's own per-user cap resets at the server's next_reset_at (never a local midnight)
    if (localCapHit(st.aiQuota, AI_CAP) && !config.mockAi) return toCustom(spans, '', { reason: 'user_limit', userDailyLimit: AI_CAP, resetsAt: st.aiQuota.resetAt });
    if (st.api.mock && !config.mockAi) return toCustom(spans, 'AI estimates need the server (this build is offline/mock). Add it yourself for now.');
    const ids = spans.map(idFor);
    for (const id of ids) { estStart.current.set(id, Date.now()); expired.current.delete(id); } // a new job: its own 35-minute clock
    setEstimating((e) => [...e, ...spans]); setBusy(true);
    const done = () => setEstimating((e) => e.filter((x) => !spans.includes(x)));
    // one handler for the first answer and for a late one (polled job): fills the SAME row by stable id
    const land = (r: Awaited<ReturnType<typeof st.api.parse>>) => {
      if (ids.every((id) => expired.current.has(id))) return; // converted by the backstop: a late result never overwrites the row
      const status = aiStatus(r);
      if (status === 'estimating') return; // no job to poll on an inline answer: stays Estimating; Add / leaving hands it to review
      if (status === 'failed') {
        const why = { reason: failReason(r), userDailyLimit: r.user_daily_limit, resetsAt: resetOf(r) };
        // every asked span gets a failed row (no AI kcal came for any of them), plus any extra open span the server listed
        const rows = failedRows(r, spans).filter((u) => !(spanIds.current.has(u) && (handedOff.current.has(idFor(u)) || expired.current.has(idFor(u))))); // handed-off spans stay needs_review
        toCustom(rows, '', why);
        done(); return;
      }
      const got = r.items.filter((x) => x.ai_estimate);
      spans.forEach((u, k) => {
        if (expired.current.has(ids[k])) return; // backstop already made this a failed row: ignore the late answer
        const its = splitBySpan(got, spans)[k];
        if (handedOff.current.has(ids[k])) { if (its.length) st.fillPending(ids[k], its); return; } // after Add / leaving: fills the review item, unconfirmed
        if (!its.length) { toCustom([u], '', { reason: failReason(r), userDailyLimit: r.user_daily_limit, resetsAt: resetOf(r) }); return; }
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
      if (cur.jobId) { jobSpans.current.set(cur.jobId, ids); for (const id of ids) jobOf.current.set(id, cur.jobId); }
      for (;;) {
        await new Promise((res) => setTimeout(res, pollDelay(cur.nextAttemptAt)));
        if (gen.current !== myGen) return; // the text changed; handed-off spans are resolved by the sync queue
        if (ids.every(gone)) { abandonIfGone(cur.jobId); return; } // every span was converted by the 35-minute backstop: stop polling, abandon the job
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
  // every row Add would save is one the store guard refuses (e.g. 5001 roti) and there is nothing else to save: Add can't
  // save, so it shows disabled (Designer Oct 17) instead of looking enabled and doing nothing; the row says why
  const guardRefuses = (it: Item) => !!entryRefusal(entryFromItem({ ...it, needs_confirmation: false }, { id: 'x', slot, raw_text: text, local_date: localDate(), tableVersion: DISH_TABLE_VERSION }));
  const addBlocked = bp.add.length > 0 && bp.add.every((r) => guardRefuses(r.it)) && !addedCustoms.length && !pendingUnmatched.length && !nOpen && !openFailed;
  const canAdd = any && !(bp.disabled && bp.later) && !addBlocked; // confirm-none: the main button is not shown at all; 'Save · N to review later' is the way out
  const addLabel = sum.button;
  const listDrafts = drafts.filter((d) => ['counted', 'batch'].includes(kindByKey.get(d.key)!));
  const openDrafts = drafts.filter((d) => ['unit', 'estimate', 'unverified'].includes(kindByKey.get(d.key)!));
  const decisionDrafts = drafts.filter((d) => kindByKey.get(d.key) === 'choice');

  const withJob = (e: FoodEntry, d: Draft): FoodEntry => { const j = jobFor(d); return j ? { ...e, job_id: j } : e; };
  function add(leave = false) {
    const date = localDate();
    // uncertain or corrected readings carry their span, so the server remembers them (Remembered foods)
    const learn = (d: Draft) => (!d.ok || d.corrected || d.it.source !== 'table') && !d.it.remembered && !d.it.learned;
    const adding = drafts.filter((d) => bp.add.some((r) => r.key === d.key));
    const es: FoodEntry[] = adding.map((d) => withJob(entryFromItem({ ...d.it, needs_confirmation: false }, { id: st.newId(), slot, raw_text: text, local_date: date, tableVersion: DISH_TABLE_VERSION, remember: learn(d) }), d));
    // offline ones wait as Pending; estimating ones go straight to items to review (at: 0), keyed by their stable id
    if (pendingUnmatched.length) st.addPending(pendingUnmatched.map((span) => {
      const id = idFor(span); handedOff.current.add(id);
      const t0 = estStart.current.get(id);
      return { id, span, slot, local_date: date, raw_text: text, ...(offline.includes(span) ? {} : { at: 0 }), ...(t0 ? { queued_at: t0 } : {}) };
    }));
    const keyOf = new Map(es.map((e, i) => [e.id, adding[i].key]));
    for (const c of addedCustoms) {
      const k = Number(c.kcal) || 0, p = Number(c.protein) || 0, now = new Date().toISOString();
      const id = st.newId(); keyOf.set(id, c.key);
      es.push({ id, local_date: date, slot, raw_text: text, dish_id: null, custom_name: c.name, qty: 1, unit: 'count', oil_level: '',
        kcal: { low: k, best: k, high: k }, protein_g: { low: p, best: p, high: p }, source: 'custom', source_note: 'Your entry',
        confirmed: true, dish_table_version: DISH_TABLE_VERSION, created_at: now, updated_at: now, deleted_at: null });
    }
    const no = Object.fromEntries((st.addEntries(es) ?? []).map((r) => [keyOf.get(r.id)!, r.reason]));
    // remember every reading the user confirmed or corrected (table items with a known dish only)
    st.remember(adding.filter((d) => !no[d.key] && learn(d) && d.it.dish_id && !d.it.ai_estimate)
      .map((d) => [learnKey(d.it.matched_text), readingOf(d.it)] as [string, ReturnType<typeof readingOf>]));
    if (Object.keys(no).length) { // refused by the store guard: those rows stay open here with the reason; the rest is saved
      for (const d of adding) if (!no[d.key]) remove(d);
      setCustoms((cs) => cs.filter((c) => !(failedCounts(c) && !no[c.key])).map((c) => (no[c.key] ? { ...c, added: false } : c)));
      setRefused(no);
      return;
    }
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
    if (pending.length) st.addPending(pending.map((f) => { const t0 = estStart.current.get(f.id); return t0 ? { ...f, queued_at: t0 } : f; }));
    return true;
  }
  const leaveRef = useRef(saveOpen); leaveRef.current = saveOpen;
  /** Backstop on this screen: spans still Estimating / Pending whose job started > 35 min ago become failed rows. */
  function checkBackstop(now = Date.now()) {
    const due = pendingUnmatched.filter((u) => { const id = spanIds.current.get(u); return !!id && !handedOff.current.has(id) && !expired.current.has(id) && backstopDue(estStart.current.get(id), now); });
    if (!due.length) return;
    for (const u of due) expired.current.add(idFor(u));
    setEstimating((e) => e.filter((x) => !due.includes(x))); setOffline((o) => o.filter((x) => !due.includes(x)));
    setCustoms((c) => [...c, ...due.filter((u) => !c.some((x) => x.key === u)).map((u) => ({ key: u, id: idFor(u), name: u, kcal: '', protein: '', added: false, reason: BACKSTOP_REASON }))]);
    for (const j of new Set(due.map((u) => jobOf.current.get(idFor(u))))) if (j) abandonIfGone(j);
  }
  const backstopRef = useRef(checkBackstop); backstopRef.current = checkBackstop;
  useBackstopTick(() => { st.expireAi(); backstopRef.current(); });
  useFocusEffect(useCallback(() => () => { if (leaveRef.current()) setText(''); }, []));
  const setItem = (d: Draft, n: Item) => d.key.startsWith('ai:') ? setAi((a) => a.map((x) => (x.key === d.key ? { ...x, it: n } : x))) : setEdits((e) => ({ ...e, [d.key]: n }));
  const remove = (d: Draft) => d.key.startsWith('ai:') ? setAi((a) => a.filter((x) => x.key !== d.key)) : setEdits((e) => ({ ...e, [d.key]: null }));
  /** AI estimate row 'Add · N kcal': saves just this row now, at its shown kcal; the footer never adds it. */
  const addOne = (d: Draft, n: Item) => {
    if (!canAddEstimate(n)) return;
    const no = st.addEntries([withJob(entryFromItem({ ...n, needs_confirmation: false }, { id: st.newId(), slot, raw_text: text, local_date: localDate(), tableVersion: DISH_TABLE_VERSION }), d)]) ?? [];
    if (no.length) { setRefused((r) => ({ ...r, [d.key]: no[0].reason })); return; } // stays open with the reason
    remove(d);
  };
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
                <Fragment key={d.key}>
                  <ItemRow it={d.it} state={d.it.remembered || d.it.learned ? 'remembered' : d.it.ai_estimate ? 'estimate' : 'plain'}
                    tableMatch={kindByKey.get(d.key) === 'batch'} onEdit={(n) => setItem(d, n)} onRemove={() => remove(d)} />
                  <Refusal why={refused[d.key]} name={d.it.name} />
                </Fragment>
              ))}
            </Group>
          ) : null}
          {openDrafts.length ? (
            <Group>
              {openDrafts.map((d) => (
                <Fragment key={d.key}>
                  <OpenRow text={text} it={d.it} kind={kindByKey.get(d.key) as 'unit' | 'estimate' | 'unverified'}
                    onConfirm={(n) => { setItem(d, n); confirm(d); }} onAdd={(n) => addOne(d, n)} onEdit={(n) => setItem(d, n)} onRemove={() => remove(d)} />
                  <Refusal why={refused[d.key]} name={d.it.name} />
                </Fragment>
              ))}
            </Group>
          ) : null}
          {decisionDrafts.map((d) => (
            <Fragment key={d.key}>
              <DecisionCard it={d.it} onPick={(x) => { setItem(d, x); confirm(d); }} onEdit={(n) => setItem(d, n)} onRemove={() => remove(d)} />
              <Refusal why={refused[d.key]} name={d.it.name} />
            </Fragment>
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
                <Fragment key={c.key}>
                  <FailedAiRow row={c} onKcal={(v) => { setRefused((r) => ({ ...r, [c.key]: '' })); setCustoms((cs) => cs.map((x) => (x.key === c.key ? { ...x, kcal: v } : x))); }}
                    onAdd={() => setCustoms((cs) => cs.map((x) => (x.key === c.key ? { ...x, added: true } : x)))} />
                  <Refusal why={refused[c.key]} name={c.name} />
                </Fragment>
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
            {bp.primary ? <Button title={addLabel} disabled={!canAdd} onPress={() => add()} accessibilityLabel={addLabel} /> : null}
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
  dock: { position: 'absolute', left: 0, right: 0, bottom: t.sizes.nav + 16, gap: 8, paddingHorizontal: t.space.md, paddingTop: 10, paddingBottom: 12, backgroundColor: t.c.bg, borderTopWidth: 1, borderTopColor: t.c.lineSoft },
  pill: { paddingVertical: 10, borderRadius: t.radius.full },
}));

/** A row the store guard refused stays on screen with why (warn token, polite live region). */
function Refusal({ why, name }: { why?: string; name: string }) {
  if (!why) return null;
  return <T v="caption" tone="warn" accessibilityLiveRegion="polite" accessibilityLabel={`${name}: not saved. ${why}`} testID="refusal">Not saved: {why}</T>;
}
