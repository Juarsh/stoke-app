import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ConfirmCard } from '@/components/ConfirmCard';
import { Glows } from '@/components/Gradient';
import { ItemCard, SlotCycle } from '@/components/ItemEditor';
import { Badge, Button, Card, Chip, Field, Row, T } from '@/components/ui';
import { entryFromItem, FoodEntry, localDate, Slot, slotFor } from '@/lib/domain';
import { AnyItem, itemKind, needsConfirmation } from '@/lib/itemKind';
import { portionLabel, SLOT_LABEL } from '@/lib/labels';
import { parseLocal } from '@/lib/parseLocal';
import { useStore } from '@/lib/store';
import { DISH_TABLE_VERSION, Item } from '@/parser';
import { makeStyles } from '@/theme';

const AI_CAP = 20;
type Draft = { key: string; it: AnyItem; ok: boolean };
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
  const table: Draft[] = parsed.items
    .map((it, i) => ({ key: `t${i}`, it: (edits[`t${i}`] ?? it) as AnyItem, ok: !!okd[`t${i}`] || !needsConfirmation(edits[`t${i}`] ?? it) }))
    .filter((d) => edits[d.key] !== null);
  const drafts = [...table, ...ai];
  const pendingUnmatched = parsed.unmatched.filter((u) => !customs.some((c) => c.key === u) && !ai.some((a) => a.key.startsWith(`ai:${u}`)));
  const aiUsedToday = st.aiUsed[localDate()] ?? 0;

  async function estimateUnknown() {
    setBusy(true);
    const toCustom = (us: string[], m: string) => { setCustoms((c) => [...c, ...us.map((u) => ({ key: u, name: u, kcal: '', protein: '' }))]); setMsg(m); };
    try {
      for (const u of pendingUnmatched) {
        if (aiUsedToday >= AI_CAP) { toCustom([u], 'AI estimates are back tomorrow. Add it yourself for now.'); continue; }
        if (st.api.mock) { toCustom([u], 'AI estimates need the server (this build is offline/mock). Add it yourself for now.'); continue; }
        const r = await st.api.parse(u, true);
        st.useAi();
        const got = r.items.filter((x) => x.ai_estimate);
        if (got.length) setAi((a) => [...a, ...got.map((it, i) => ({ key: `ai:${u}:${i}`, it, ok: false }))]);
        else toCustom([u], r.message ?? 'Add it yourself for now.');
      }
    } catch { toCustom(pendingUnmatched, 'Couldn’t reach AI estimates. Add it yourself for now.'); } finally { setBusy(false); }
  }

  const blocked = drafts.filter((d) => !d.ok);
  const nConfirm = blocked.filter((d) => itemKind(d.it) !== 'did_you_mean').length;
  const nResolve = blocked.length - nConfirm + (customs.some((c) => !(Number(c.kcal) > 0)) ? customs.filter((c) => !(Number(c.kcal) > 0)).length : 0) + pendingUnmatched.length;
  const total = drafts.reduce((a, d) => a + d.it.kcal.best, 0) + customs.reduce((a, c) => a + (Number(c.kcal) || 0), 0);
  const protein = drafts.reduce((a, d) => a + d.it.protein_g.best, 0) + customs.reduce((a, c) => a + (Number(c.protein) || 0), 0);
  const any = drafts.length + customs.length > 0;
  const canAdd = any && nConfirm === 0 && nResolve === 0;
  const addLabel = nConfirm ? `Confirm ${nConfirm} item${nConfirm > 1 ? 's' : ''} to add` : nResolve ? `Resolve ${nResolve} item${nResolve > 1 ? 's' : ''} to add` : 'Add';

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
          {drafts.map((d) => {
            const k = itemKind(d.it);
            if (!d.ok && (k === 'did_you_mean' || k === 'generic')) {
              return <ConfirmCard key={d.key} it={d.it} onResolve={(x) => { setItem(d, x); confirm(d); }} onRemove={() => remove(d)} />;
            }
            return (
              <ItemCard key={d.key} it={d.it} slot={slot} confirmed={d.ok} onEdit={(n) => setItem(d, n)} onConfirm={() => confirm(d)} onRemove={() => remove(d)}
                onSlot={() => { setSlot(SlotCycle(slot)); setSlotAuto(false); }} />
            );
          })}
          {pendingUnmatched.length ? (
            <Card>
              <T v="bodyStrong">Not in our table yet: {pendingUnmatched.join(', ')}</T>
              <Button kind="soft" title={busy ? 'Estimating…' : 'Get AI estimate'} disabled={busy} onPress={estimateUnknown} />
              <T v="caption" tone="muted">AI estimates used today: {aiUsedToday}/{AI_CAP}</T>
            </Card>
          ) : null}
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
            <Card tone="card2" style={s.pill}><T v="number">{Math.round(total)} <T v="caption" tone="muted">kcal · {Math.round(protein * 10) / 10} g</T></T></Card>
            <Button title={addLabel} disabled={!canAdd} onPress={add} style={{ flex: 1 }} />
          </View>
        ) : null}
      </SafeAreaView>
    </View>
  );
}
const useStyles = makeStyles((t) => ({
  pad: { padding: t.space.screen, gap: t.space.gap, paddingBottom: t.sizes.nav + 140 },
  dock: { position: 'absolute', left: t.space.md, right: t.space.md, bottom: t.sizes.nav + 28, flexDirection: 'row', gap: 8, alignItems: 'center' },
  pill: { paddingVertical: 10, borderRadius: t.radius.full },
}));
