import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ConfirmCard } from '@/components/ConfirmCard';
import { Glows } from '@/components/Gradient';
import { ItemCard, SlotCycle } from '@/components/ItemEditor';
import { Badge, Button, Card, Chip, Field, Row, T } from '@/components/ui';
import { entryFromItem, FoodEntry, localDate, Slot, slotFor } from '@/lib/domain';
import { AnyItem, isPlaceholder, itemKind } from '@/lib/itemKind';
import { PendingRow } from '@/components/PendingRow';
import { logSummary } from '@/lib/logSummary';
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
type Custom = { key: string; name: string; kcal: string; protein: string };

export default function Log() {
  const st = useStore(); const router = useRouter(); const s = useStyles();
  const { prefill } = useLocalSearchParams<{ prefill?: string }>();
  const [text, setText] = useState('');
  const [slot, setSlot] = useState<Slot>(slotFor(new Date()));
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

  async function estimateUnknown(spans: string[]) {
    const toCustom = (us: string[], m: string) => { setCustoms((c) => [...c, ...us.map((u) => ({ key: u, name: u, kcal: '', protein: '' }))]); setMsg(m); };
    if (aiUsedToday >= AI_CAP) return toCustom(spans, 'AI estimates are back tomorrow. Add it yourself for now.');
    if (st.api.mock && !config.mockAi) return toCustom(spans, 'AI estimates need the server (this build is offline/mock). Add it yourself for now.');
    const ids = spans.map(idFor);
    setEstimating((e) => [...e, ...spans]); setBusy(true);
    try {
      const r = await st.api.parse(spans.join(', '), true);
      st.useAi();
      const got = r.items.filter((x) => x.ai_estimate);
      spans.forEach((u, k) => {
        const its = splitBySpan(got, spans)[k];
        if (handedOff.current.has(ids[k])) { st.fillPending(ids[k], its); return; } // late: fill the review item, unconfirmed
        if (its.length) setAi((a) => [...a, ...its.map((it, i) => ({ key: `ai:${u}:${ids[k]}:${i}`, it, ok: false }))]);
        else toCustom([u], r.message ?? 'Add it yourself for now.');
      });
      setEstimating((e) => e.filter((x) => !spans.includes(x)));
    } catch {
      // network down or a 202 job: offline Pending (queued without a number on Add)
      setEstimating((e) => e.filter((x) => !spans.includes(x)));
      setOffline((o) => [...o, ...spans.filter((u) => !handedOff.current.has(idFor(u)))]);
      setMsg('No connection. These stay pending and fill in when you’re back online.');
    } finally { setBusy(false); }
  }

  // Confirmation is the primary action, not a blocker: Add confirms every CHECK/AI item.
  const unsure = drafts.filter((d) => !d.ok).length;
  const customMissing = customs.some((c) => !(Number(c.kcal) > 0)); // the only disabled state (missing data)
  const total = drafts.reduce((a, d) => a + d.it.kcal.best, 0) + customs.reduce((a, c) => a + (Number(c.kcal) || 0), 0);
  const protein = drafts.reduce((a, d) => a + d.it.protein_g.best, 0) + customs.reduce((a, c) => a + (Number(c.protein) || 0), 0);
  // Offline Pending = '— kcal', not counted. Estimating = shimmer; Add stays enabled and sends them to items to review.
  const nEstimating = pendingUnmatched.filter((u) => !offline.includes(u)).length;
  const nPending = pendingUnmatched.length - nEstimating;
  const sum = logSummary({ kcal: total, protein, items: drafts.length + customs.filter((c) => Number(c.kcal) > 0).length, estimating: nEstimating, pending: nPending,
    toConfirm: unsure, estimates: drafts.filter((d) => d.it.ai_estimate).length, needsKcal: customs.filter((c) => !(Number(c.kcal) > 0)).length });
  const any = drafts.length + customs.length + pendingUnmatched.length > 0;
  const canAdd = any && !sum.disabled && !customMissing;
  const allEst = sum.allEstimates;
  const addLabel = sum.button;

  function add() {
    const date = localDate();
    // uncertain or corrected readings carry their span, so the server remembers them (Remembered foods)
    const learn = (d: Draft) => (!d.ok || d.corrected || d.it.source !== 'table') && !d.it.remembered && !d.it.learned;
    const es: FoodEntry[] = drafts.map((d) => entryFromItem(d.it, { id: st.newId(), slot, raw_text: text, local_date: date, tableVersion: DISH_TABLE_VERSION, remember: learn(d) }));
    // offline ones wait as Pending; estimating ones go straight to items to review (at: 0), keyed by their stable id
    if (pendingUnmatched.length) st.addPending(pendingUnmatched.map((span) => {
      const id = idFor(span); handedOff.current.add(id);
      return { id, span, slot, local_date: date, raw_text: text, ...(offline.includes(span) ? {} : { at: 0 }) };
    }));
    for (const c of customs) {
      const k = Number(c.kcal) || 0, p = Number(c.protein) || 0, now = new Date().toISOString();
      es.push({ id: st.newId(), local_date: date, slot, raw_text: text, dish_id: null, custom_name: c.name, qty: 1, unit: 'count', oil_level: '',
        kcal: { low: k, best: k, high: k }, protein_g: { low: p, best: p, high: p }, source: 'custom', source_note: 'Your entry',
        confirmed: true, dish_table_version: DISH_TABLE_VERSION, created_at: now, updated_at: now, deleted_at: null });
    }
    st.addEntries(es);
    // remember every reading the user confirmed or corrected (table items with a known dish only)
    st.remember(drafts.filter((d) => learn(d) && d.it.dish_id && !d.it.ai_estimate)
      .map((d) => [learnKey(d.it.matched_text), readingOf(d.it)] as [string, ReturnType<typeof readingOf>]));
    setText('');
    router.navigate('/');
  }
  const setItem = (d: Draft, n: Item) => d.key.startsWith('ai:') ? setAi((a) => a.map((x) => (x.key === d.key ? { ...x, it: n } : x))) : setEdits((e) => ({ ...e, [d.key]: n }));
  const remove = (d: Draft) => d.key.startsWith('ai:') ? setAi((a) => a.filter((x) => x.key !== d.key)) : setEdits((e) => ({ ...e, [d.key]: null }));
  const confirm = (d: Draft) => d.key.startsWith('ai:') ? setAi((a) => a.map((x) => (x.key === d.key ? { ...x, ok: true } : x))) : setOkd((o) => ({ ...o, [d.key]: true }));

  return (
    <View style={{ flex: 1 }}>
      <Glows />
      <SafeAreaView edges={['top']} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
          <Row style={{ justifyContent: 'space-between' }}>
            <T v="title">Kya khaya?</T>
            <Chip kind="primary" label={`${SLOT_LABEL[slot]}${slotAuto ? ' · auto' : ''} ✎`} onPress={() => { setSlot(SlotCycle(slot)); setSlotAuto(false); }} a11y={`Meal slot ${SLOT_LABEL[slot]}, double-tap to change`} />
          </Row>
          <Field big value={text} onChangeText={setText} multiline placeholder="2 roti dal sabzi thoda ghee" accessibilityLabel="What did you eat?" autoCorrect={false} />
          {parsed.items.length || parsed.unmatched.length ? (
            <Row style={{ flexWrap: 'wrap', gap: 6 }}>
              {parsed.items.map((it, i) => <Chip key={i} label={`${portionLabel(it.quantity, it.unit)} ${it.name}`} faded={i > 2} />)}
              {parsed.unmatched.map((u) => <Chip key={u} kind="neutral" label={`${u}…`} faded />)}
            </Row>
          ) : null}
          {allEst ? (
            <Row style={{ justifyContent: 'space-between' }}>
              <T tone="text2"><T tone="em">✦ </T>AI estimates · tap any to adjust</T>
              <T tone="muted" accessibilityRole="button" accessibilityLabel="How estimates work" onPress={() => setMsg('Estimates come from AI when a dish isn’t in our table. Tap one to change the amount or numbers.')}>ⓘ</T>
            </Row>
          ) : null}
          {drafts.map((d) => {
            const k = itemKind(d.it);
            if (!d.ok && k !== 'ai_estimate') {
              return <ConfirmCard key={d.key} it={d.it} onResolve={(x) => { setItem(d, x); confirm(d); }} onRemove={() => remove(d)} />;
            }
            // (AI items stay unconfirmed until Add; their card offers Change)
            return (
              <ItemCard key={d.key} it={d.it} slot={slot} confirmed={d.ok} plain={allEst} remembered={!!d.it.remembered} onEdit={(n) => setItem(d, n)} onConfirm={() => confirm(d)} onRemove={() => remove(d)}
                onSlot={() => { setSlot(SlotCycle(slot)); setSlotAuto(false); }} />
            );
          })}
          {pendingUnmatched.length ? (
            <Card>
              {pendingUnmatched.map((u) => <PendingRow key={u} label={u} sub="read from your text" state={offline.includes(u) ? 'offline' : 'estimating'} />)}
            </Card>
          ) : null}
          {nEstimating ? <T v="caption" tone="muted">Estimates usually take 1–2 seconds.</T> : nPending ? <T v="caption" tone="muted">{msg}</T> : null}
          {customs.map((c) => (
            <Card key={c.key} tone="card2">
              <Row style={{ justifyContent: 'space-between' }}><T v="bodyStrong">Custom item</T><Badge kind="brand" label="needs numbers" /></Row>
              {msg ? <T v="caption" tone="muted">{msg}</T> : null}
              <Field label="Name" value={c.name} onChangeText={(v) => setCustoms((cs) => cs.map((x) => (x.key === c.key ? { ...x, name: v } : x)))} />
              <Row>
                <View style={{ flex: 1 }}><Field label="kcal" keyboardType="numeric" value={c.kcal} onChangeText={(v) => setCustoms((cs) => cs.map((x) => (x.key === c.key ? { ...x, kcal: v } : x)))} /></View>
                <View style={{ flex: 1 }}><Field label="Protein g" keyboardType="numeric" value={c.protein} onChangeText={(v) => setCustoms((cs) => cs.map((x) => (x.key === c.key ? { ...x, protein: v } : x)))} /></View>
              </Row>
            </Card>
          ))}
          <T v="caption" tone="muted">Numbers are best guesses; tap a number for the range and where it comes from.</T>
        </ScrollView>
        {any ? (
          <View style={s.dock}>
            <Row style={{ justifyContent: 'space-between' }}>
              <T v="caption" tone="muted">{sum.total}</T>
              <T v="number">{sum.kcalText} <T v="caption" tone="muted">{sum.soFar ? 'kcal so far' : `kcal · ${sum.protein} g`}</T></T>
            </Row>
            <Button title={addLabel} disabled={!canAdd} onPress={add} accessibilityLabel={addLabel} />
          </View>
        ) : null}
      </SafeAreaView>
    </View>
  );
}
const useStyles = makeStyles((t) => ({
  pad: { padding: t.space.screen, gap: t.space.gap, paddingBottom: t.sizes.nav + 140 },
  dock: { position: 'absolute', left: t.space.md, right: t.space.md, bottom: t.sizes.nav + 28, gap: 8 },
  pill: { paddingVertical: 10, borderRadius: t.radius.full },
}));
