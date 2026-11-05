// Coach tab: Ask Coach chat when signed in, plus the existing "Picks that fit" cards.
// Signed out (Expo Go) or offline: no server call; local rules-based picks and a sign-in note.
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Pressable, View } from 'react-native';
import { FoodTile } from '@/components/FoodTile';
import { Card, Chip, Field, Row, Screen, T } from '@/components/ui';
import { leftForToday, pickItem, portionOf, type Suggestion } from '@/lib/coach';
import { askCoach, canAskCoach, clipCoachMessages, coachReasonNote, COACH_SIGNIN_NOTE, loadCoachChat, saveCoachChat, SUGGESTED_QUESTIONS, suggestionFromPick, type CoachStoredMessage } from '@/lib/data';
import { entryFromItem, dayOf, slotFor } from '@/lib/domain';
import { grams as g, kc } from '@/lib/format';
import { useStore } from '@/lib/store';
import { useDay } from '@/lib/useDay';
import { serverConfirm } from '@/lib/parseLocal';
import { DISH_TABLE_VERSION, oneTap, parser } from '@/parser';
import { makeStyles, useTheme } from '@/theme';


export default function Coach() {
  const d = useDay(); const t = useTheme(); const s = useStyles(); const st = useStore();
  const diet = d.profile?.diet === 'veg' ? 'Veg' : d.profile?.diet === 'egg' ? 'Egg + veg' : 'Veg + non-veg';
  const lf = leftForToday(d.kcalTarget, d.proteinTarget, d.tot.kcal, d.tot.protein);
  const router = useRouter(); const ins = useSafeAreaInsets();
  const [toast, setToast] = useState<{ id: string; name: string; kcal: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const log = (p: Suggestion) => {
    const it = pickItem(p, (x) => { const r = parser.parse(x); return { items: serverConfirm(x, r), unmatched: r.unmatched }; }, oneTap);
    // instant save only for a one_tap_ok row; anything else opens Log prefilled so the user sees and confirms it
    if (!it || it.one_tap_ok !== true) { router.push({ pathname: '/log', params: { prefill: p.label } }); return; }
    const id = st.newId();
    const no = st.addEntries([entryFromItem(it, { id, slot: slotFor(new Date()), raw_text: p.label, local_date: dayOf(), tableVersion: DISH_TABLE_VERSION })]) ?? [];
    // refused by the store guard: never dropped silently, the row opens in Log for the user to see and fix
    if (no.length) { router.push({ pathname: '/log', params: { prefill: p.label } }); return; }
    setToast({ id, name: p.dish.name.charAt(0).toUpperCase() + p.dish.name.slice(1), kcal: Math.round(it.kcal.best) });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 5000);
  };
  // undo = the same persisted delete as anywhere else: local tombstone + queued server delete (replaces a not-yet-sent upsert)
  const undo = () => { if (toast) st.deleteEntry(toast.id); setToast(null); if (timer.current) clearTimeout(timer.current); };

  const canAsk = canAskCoach({ signedIn: !!st.signedInGoogle, offline: d.offline, local: !!st.api?.mock });
  const [messages, setMessages] = useState<CoachStoredMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { void loadCoachChat().then(setMessages); }, []);
  const remember = async (next: CoachStoredMessage[]) => {
    const kept = clipCoachMessages(next);
    setMessages(kept);
    try { await saveCoachChat(kept); } catch { /* still show in memory so Expo Go never crashes on storage */ }
  };
  const send = async (text: string) => {
    const q = text.trim();
    if (!q || busy || !canAsk) return;
    setDraft('');
    const userMsg: CoachStoredMessage = { id: st.newId(), role: 'user', text: q };
    const history = messages;
    const withUser = clipCoachMessages([...messages, userMsg]);
    setMessages(withUser);
    setBusy(true);
    try {
      const ans = await askCoach(st.api, q, history);
      const bot: CoachStoredMessage = {
        id: st.newId(), role: 'assistant', text: ans.answer || coachReasonNote(ans.reason),
        source: ans.source, reason: ans.reason,
        picks: ans.source === 'rules' ? ans.picks : undefined,
      };
      await remember([...withUser, bot]);
    } catch {
      await remember([...withUser, { id: st.newId(), role: 'assistant', text: coachReasonNote('ai_error'), source: 'rules', reason: 'ai_error', picks: [] }]);
    } finally {
      setBusy(false);
    }
  };

  const heroA11y = lf.over ? `${kc(lf.kcalOver)} calories over today. Lighter picks below.` : `Left for today: ${kc(lf.kcalLeft)} calories, ${lf.proteinMet ? 'protein goal met' : `${Math.round(lf.proteinLeft)} grams protein`}`;
  const pickCards = (list: Suggestion[]) => list.map((p) => (
    <Card key={p.dish.id}>
      <Row style={{ gap: 12 }}>
        <FoodTile seed={p.dish.id} category={p.dish.category} size={44} />
        <View style={{ flex: 1 }}>
          <T v="bodyStrong" style={{ fontSize: 14 }}>{p.dish.name.charAt(0).toUpperCase() + p.dish.name.slice(1)}</T>
          <T v="caption" tone="muted">{portionOf(p)} · {kc(p.kcal)} kcal · {g(p.protein)} protein</T>
        </View>
        <Pressable onPress={() => log(p)} accessibilityRole="button" accessibilityLabel={`Log ${portionOf(p)} ${p.dish.name}, ${kc(p.kcal)} calories`}
          style={({ pressed }) => [s.logBtn, pressed && { opacity: 0.85 }]}>
          <T v="bodyStrong" tone="em" style={{ fontWeight: '700' }}>Log</T>
        </Pressable>
      </Row>
    </Card>
  ));
  const picksOf = (m: CoachStoredMessage): Suggestion[] => {
    const from = (m.picks ?? []).map(suggestionFromPick).filter((p): p is Suggestion => !!p);
    return from.length ? from : d.picks;
  };

  return (
    <View style={{ flex: 1 }}>
    <Screen title="Coach">
      <View style={s.hero} accessible accessibilityLabel={heroA11y}>
        <T v="bodyStrong" tone="text2">Left for today</T>
        <Row style={{ alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
          <T v="displayM" style={{ fontSize: 48, lineHeight: 52 }}>{kc(lf.over ? lf.kcalOver : lf.kcalLeft)}</T>
          <T v="bodyStrong" tone="text2">{lf.over ? 'kcal over' : 'kcal left'}</T>
        </Row>
        {lf.over ? <T v="bodyStrong" tone="text2">Lighter picks below</T>
          : lf.proteinMet ? <T v="bodyStrong" tone="text2">Protein goal met</T>
          : <Row style={{ alignItems: 'baseline', gap: 4 }}><T v="bodyStrong" style={{ fontSize: 20, lineHeight: 26 }}>{g(lf.proteinLeft)}</T><T v="bodyStrong" tone="text2">protein left</T></Row>}
        <T v="caption" tone="muted">Target {kc(d.kcalTarget)} kcal · {g(d.proteinTarget)} protein</T>
      </View>

      {!canAsk ? (
        <>
          <T v="caption" tone="muted">{COACH_SIGNIN_NOTE}</T>
          <Row style={{ justifyContent: 'space-between' }}>
            <T v="bodyStrong" style={{ fontSize: 15 }}>Picks that fit</T>
            <T v="caption" tone="muted">{diet} · from our dish table</T>
          </Row>
          {pickCards(d.picks)}
          <T v="caption" tone="muted">Picks are rules-based, not AI.</T>
        </>
      ) : (
        <>
          {messages.map((m) => (
            <View key={m.id} style={[s.bubble, m.role === 'user' ? s.userBubble : s.botBubble]} accessibilityLabel={m.role === 'user' ? `You said: ${m.text}` : undefined}>
              <T v="body" tone="text">{m.text}</T>
              {m.role === 'assistant' && m.source === 'rules' ? (
                <View style={{ gap: 8, marginTop: 8 }}>
                  <T v="caption" tone="muted">{coachReasonNote(m.reason)}</T>
                  {pickCards(picksOf(m))}
                </View>
              ) : null}
            </View>
          ))}
          {busy ? <T v="caption" tone="muted" accessibilityLiveRegion="polite">Thinking…</T> : null}
          <Row style={{ flexWrap: 'wrap', gap: 8 }}>
            {SUGGESTED_QUESTIONS.map((q) => (
              <Chip key={q} kind="neutral" label={q} a11y={q} onPress={busy ? undefined : () => { void send(q); }} />
            ))}
          </Row>
          <Row style={{ alignItems: 'flex-end', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Field value={draft} onChangeText={setDraft} placeholder="Ask about food, training or habits" accessibilityLabel="Ask Coach a question"
                editable={!busy} returnKeyType="send" onSubmitEditing={() => { void send(draft); }} />
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Send question" disabled={busy || !draft.trim()} onPress={() => { void send(draft); }}
              style={({ pressed }) => [s.send, (busy || !draft.trim()) && { opacity: 0.4 }, pressed && { opacity: 0.85 }]}>
              <T v="bodyStrong" tone="em">Send</T>
            </Pressable>
          </Row>
        </>
      )}
      <View style={{ height: 140 }} />
    </Screen>
    {toast ? (
      <View style={[s.toast, { bottom: ins.bottom + t.sizes.nav + 28 }]} accessibilityLiveRegion="polite">
        <T tone="text" style={{ flex: 1 }} numberOfLines={1}>Added {toast.name} · {kc(toast.kcal)} kcal</T>
        <Pressable onPress={undo} accessibilityRole="button" accessibilityLabel={`Undo adding ${toast.name}`} style={s.undo}><T v="bodyStrong" tone="em">Undo</T></Pressable>
      </View>
    ) : null}
    </View>
  );
}
const useStyles = makeStyles((t) => ({
  hero: { backgroundColor: t.c.accentTint, borderRadius: 18, borderWidth: 1, borderColor: t.c.emTintLine, padding: t.space.cardH, gap: 4 },
  logBtn: { minWidth: 64, minHeight: 44, borderRadius: 12, borderWidth: 1.5, borderColor: t.c.cardLine, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  toast: { position: 'absolute', left: 16, right: 16, ...t.elev.e1, flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 14, borderWidth: 1, borderColor: t.c.cardLine, backgroundColor: t.c.card, paddingLeft: 14 },
  undo: { minHeight: 44, minWidth: 64, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  bubble: { maxWidth: '92%', borderRadius: 16, padding: t.space.cardH, borderWidth: 1 },
  userBubble: { alignSelf: 'flex-end', backgroundColor: t.c.accentTint, borderColor: t.c.emTintLine },
  botBubble: { alignSelf: 'flex-start', backgroundColor: t.c.card, borderColor: t.c.cardLine },
  send: { minWidth: 64, minHeight: 44, borderRadius: 12, borderWidth: 1.5, borderColor: t.c.cardLine, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
}));
