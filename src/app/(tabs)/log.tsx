import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { DidYouMean } from '@/components/DidYouMean';
import { ItemCard, SlotCycle } from '@/components/ItemEditor';
import type { CheckedItem } from '@/lib/sanity';
import { Badge, Button, Card, Chip, Field, Row, Screen, T } from '@/components/ui';
import { parseLocal } from '@/lib/parseLocal';
import { entryFromItem, FoodEntry, localDate, Slot, slotFor } from '@/lib/domain';
import { SLOT_LABEL } from '@/lib/labels';
import { useStore } from '@/lib/store';
import { DISH_TABLE_VERSION, Item } from '@/parser';

const AI_CAP = 20;
type Draft = { key: string; it: Item; confirmed: boolean; ask?: CheckedItem };
type Custom = { key: string; name: string; kcal: string; protein: string };

export default function Log() {
  const st = useStore(); const router = useRouter();
  const { prefill } = useLocalSearchParams<{ prefill?: string }>();
  const [text, setText] = useState('');
  const [slot, setSlot] = useState<Slot>(slotFor(new Date()));
  const [slotAuto, setSlotAuto] = useState(true);
  const [edits, setEdits] = useState<Record<string, Item | null>>({});
  const [ai, setAi] = useState<Draft[]>([]);
  const [customs, setCustoms] = useState<Custom[]>([]);
  const [msg, setMsg] = useState('');
  const [resolved, setResolved] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (prefill) setText(String(prefill)); }, [prefill]);

  // Offline table parse on every keystroke (<100 ms).
  const parsed = useMemo(() => parseLocal(text), [text]);
  useEffect(() => { setEdits({}); setAi([]); setCustoms([]); setMsg(''); setResolved({}); }, [text]);
  const table: Draft[] = parsed.items.map((it, i) => ({ key: `t${i}`, it: edits[`t${i}`] ?? it, confirmed: true, ask: it.needs_confirm && !resolved[`t${i}`] ? it : undefined })).filter((d) => edits[d.key] !== null);
  const drafts = [...table, ...ai];
  const pendingUnmatched = parsed.unmatched.filter((u) => !customs.some((c) => c.key === u) && !ai.some((a) => a.key.startsWith(`ai:${u}`)));
  const aiUsedToday = st.aiUsed[localDate()] ?? 0;

  async function estimateUnknown() {
    setBusy(true);
    try {
      for (const u of pendingUnmatched) {
        if (st.api.mock || aiUsedToday >= AI_CAP) {
          setCustoms((c) => [...c, { key: u, name: u, kcal: '', protein: '' }]);
          setMsg(aiUsedToday >= AI_CAP ? 'AI estimates are back tomorrow. Add it yourself for now.' : 'AI estimates need the server (offline/mock mode). Add it yourself for now.');
          continue;
        }
        const r = await st.api.parse(u, true);
        st.useAi();
        const got = r.items.filter((x) => x.ai_estimate);
        if (got.length) setAi((a) => [...a, ...got.map((it, i) => ({ key: `ai:${u}:${i}`, it, confirmed: false }))]);
        else { setCustoms((c) => [...c, { key: u, name: u, kcal: '', protein: '' }]); if (r.message) setMsg(r.message); }
      }
    } catch {
      setCustoms((c) => [...c, ...pendingUnmatched.map((u) => ({ key: u, name: u, kcal: '', protein: '' }))]);
      setMsg('Couldn’t reach AI estimates. Add it yourself for now.');
    } finally { setBusy(false); }
  }

  const unconfirmed = ai.filter((a) => !a.confirmed).length;
  const unpicked = table.filter((d) => d.ask).length;
  const customMissing = customs.some((c) => !(Number(c.kcal) > 0));
  const total = drafts.reduce((a, d) => a + d.it.kcal.best, 0) + customs.reduce((a, c) => a + (Number(c.kcal) || 0), 0);
  const protein = drafts.reduce((a, d) => a + d.it.protein_g.best, 0) + customs.reduce((a, c) => a + (Number(c.protein) || 0), 0);
  const canAdd = (drafts.length + customs.length) > 0 && unconfirmed === 0 && unpicked === 0 && !customMissing && pendingUnmatched.length === 0;
  const addLabel = unpicked ? 'Add (pick a portion first)' : unconfirmed ? `Add (confirm AI item${unconfirmed > 1 ? 's' : ''} first)` : customMissing ? 'Add (fill kcal first)' : pendingUnmatched.length ? 'Add (handle unknown items first)' : `Add ${Math.round(total)} kcal`;

  function add() {
    const date = localDate();
    const es: FoodEntry[] = drafts.map((d) => entryFromItem(d.it, { id: st.newId(), slot, raw_text: text, local_date: date, tableVersion: DISH_TABLE_VERSION }));
    for (const c of customs) {
      const k = Number(c.kcal) || 0, p = Number(c.protein) || 0, now = new Date().toISOString();
      es.push({ id: st.newId(), local_date: date, slot, raw_text: text, dish_id: null, custom_name: c.name, qty: 1, unit: 'count', oil_level: '',
        kcal: { low: k, best: k, high: k }, protein_g: { low: p, best: p, high: p }, source: 'custom', source_note: 'Your entry',
        confirmed: true, dish_table_version: DISH_TABLE_VERSION, created_at: now, updated_at: now, deleted_at: null });
    }
    st.addEntries(es);
    setText('');
    router.navigate('/');
  }

  return (
    <Screen title="Log" right={<Chip kind="neutral" label={`${SLOT_LABEL[slot]}${slotAuto ? ' (auto)' : ''} ✎`} onPress={() => { setSlot(SlotCycle(slot)); setSlotAuto(false); }} a11y={`Meal slot ${SLOT_LABEL[slot]}, double-tap to change`} />}>
      <Field value={text} onChangeText={setText} multiline placeholder="2 roti dal sabzi thoda ghee" accessibilityLabel="What did you eat?" autoCorrect={false} style={{ minHeight: 72 }} />
      {drafts.map((d) => d.ask ? (
        <DidYouMean key={d.key} it={d.ask} alternatives={d.ask.alternatives ?? []} onPick={(x) => { setEdits((e) => ({ ...e, [d.key]: x })); setResolved((r) => ({ ...r, [d.key]: true })); }} />
      ) : (
        <ItemCard key={d.key} it={d.it} slot={slot} confirmed={d.confirmed}
          onEdit={(n) => d.key.startsWith('ai:') ? setAi((a) => a.map((x) => (x.key === d.key ? { ...x, it: n } : x))) : (setEdits((e) => ({ ...e, [d.key]: n })), setResolved((r) => ({ ...r, [d.key]: true })))}
          onConfirm={() => setAi((a) => a.map((x) => (x.key === d.key ? { ...x, confirmed: true } : x)))}
          onRemove={() => d.key.startsWith('ai:') ? setAi((a) => a.filter((x) => x.key !== d.key)) : setEdits((e) => ({ ...e, [d.key]: null }))}
          onSlot={() => { setSlot(SlotCycle(slot)); setSlotAuto(false); }} />
      ))}
      {pendingUnmatched.length ? (
        <Card>
          <T v="bodyStrong">Not in our table yet: {pendingUnmatched.join(', ')}</T>
          <Button kind="soft" title={busy ? 'Estimating…' : 'Get AI estimate'} disabled={busy} onPress={estimateUnknown} />
          <T v="caption" tone="muted">AI estimates used today: {aiUsedToday}/{AI_CAP}</T>
        </Card>
      ) : null}
      {customs.map((c) => (
        <Card key={c.key} tone="surface2">
          <Row style={{ justifyContent: 'space-between' }}><T v="bodyStrong">Custom item</T><Badge kind="brand" label="needs numbers" /></Row>
          {msg ? <T v="caption" tone="muted">{msg}</T> : null}
          <Field label="Name" value={c.name} onChangeText={(v) => setCustoms((cs) => cs.map((x) => (x.key === c.key ? { ...x, name: v } : x)))} />
          <Row>
            <View style={{ flex: 1 }}><Field label="kcal" keyboardType="numeric" value={c.kcal} onChangeText={(v) => setCustoms((cs) => cs.map((x) => (x.key === c.key ? { ...x, kcal: v } : x)))} /></View>
            <View style={{ flex: 1 }}><Field label="Protein g" keyboardType="numeric" value={c.protein} onChangeText={(v) => setCustoms((cs) => cs.map((x) => (x.key === c.key ? { ...x, protein: v } : x)))} /></View>
          </Row>
        </Card>
      ))}
      {drafts.length + customs.length ? <T v="bodyStrong">{Math.round(total)} kcal · {Math.round(protein * 10) / 10} g protein</T> : null}
      <Button title={addLabel} disabled={!canAdd} onPress={add} />
      <T v="caption" tone="muted">Numbers are best guesses; tap a number for the range and where it comes from.</T>
      <View style={{ height: 80 }} />
    </Screen>
  );
}
