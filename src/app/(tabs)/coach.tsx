// v3.2 coach (Oct 16): "Left for today" hero, 3 rules-based "Picks that fit" with a 64x44 outline Log button.
// Log = one tap: saves the pick with the table numbers (only picks the parser reads back as a confident one-tap
// table item reach this list, see pickItem), then an undo toast. No warnings, never red when over.
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Pressable, View } from 'react-native';
import { FoodTile } from '@/components/FoodTile';
import { Card, Row, Screen, T } from '@/components/ui';
import { leftForToday, pickItem, portionOf, type Suggestion } from '@/lib/coach';
import { entryFromItem, localDate, slotFor } from '@/lib/domain';
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
    st.addEntries([entryFromItem(it, { id, slot: slotFor(new Date()), raw_text: p.label, local_date: localDate(), tableVersion: DISH_TABLE_VERSION })]);
    setToast({ id, name: p.dish.name.charAt(0).toUpperCase() + p.dish.name.slice(1), kcal: Math.round(it.kcal.best) });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 5000);
  };
  // undo = the same persisted delete as anywhere else: local tombstone + queued server delete (replaces a not-yet-sent upsert)
  const undo = () => { if (toast) st.deleteEntry(toast.id); setToast(null); if (timer.current) clearTimeout(timer.current); };
  const heroA11y = lf.over ? `${kc(lf.kcalOver)} calories over today. Lighter picks below.` : `Left for today: ${kc(lf.kcalLeft)} calories, ${lf.proteinMet ? 'protein goal met' : `${Math.round(lf.proteinLeft)} grams protein`}`;
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
      <Row style={{ justifyContent: 'space-between' }}>
        <T v="bodyStrong" style={{ fontSize: 15 }}>Picks that fit</T>
        <T v="caption" tone="muted">{diet} · from our dish table</T>
      </Row>
      {d.picks.map((p) => (
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
      ))}
      <T v="caption" tone="muted">Picks are rules-based, not AI.</T>
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
}));
