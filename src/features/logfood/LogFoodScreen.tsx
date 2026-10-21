// Log food S2.1 (spec §5, locked v4 frames rework/v4/logfood/frames/s2-*): search first, quick +, item sheet, tray rows,
// "Log N items · X kcal" with the time chip (§4). Nothing saves until Log; Log is all-or-nothing through the store gate.
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { T } from '@/components/ui';
import { useStore } from '@/lib/store';
import { useTheme } from '@/theme';
import { buildEntries, chipLabel, compute, amountLabel, Food, foodId, foodName, logLabel, newTrayItem, pickTime, quickAdd, recentFoods, searchAll,
  TimePick, timeReason, TrayItem, trayCount, trayTotal, defaultUnit, defaultAmount } from './model';
import { FoodForm } from '@/features/myfoods/FoodForm';
import { isMine, newDraft } from '@/features/myfoods/model';
import { SaveButton } from '@/features/myfoods/SaveButton';
import { useFoodDraft } from '@/features/myfoods/useFoodDraft';
import { ItemSheet } from './ItemSheet';
import { TimeSheet } from './TimeSheet';
import { Toast } from '@/components/Toast';

const kc = (n: number) => Math.round(n).toLocaleString('en-IN');
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function LogFoodScreen({ now: nowProp }: { now?: () => Date }) {
  const t = useTheme(); const ins = useSafeAreaInsets(); const router = useRouter(); const st = useStore();
  const now = nowProp ?? (() => new Date());
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [tray, setTray] = useState<TrayItem[]>([]);
  const [time, setTime] = useState<TimePick>({ kind: 'now' });
  const [sheet, setSheet] = useState<{ item: TrayItem; editing: boolean } | null>(null);
  const [timeOpen, setTimeOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; label: string; undo: () => void } | null>(null);
  const [refused, setRefused] = useState<Record<string, string>>({});
  const keyN = useRef(0);
  const nextKey = () => `t${++keyN.current}`;

  const results = useMemo(() => searchAll(query, st.myFoods), [query, st.myFoods]);
  const recent = useMemo(() => recentFoods(st.entries, st.myFoods), [st.entries, st.myFoods]);
  const total = trayTotal(tray);
  const q = query.trim();
  const noMatch = !!q && !results.length;
  // §6.4 No match: "Add your own food" with the search text as the name; "Save and add" saves it and adds 1 unit
  const own = useFoodDraft(newDraft(cap(q)), st.myFoods);
  const ownReset = own.reset;
  useEffect(() => { ownReset(newDraft(cap(q))); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  const saveAndAdd = () => {
    const food = own.trySave(st.newId());
    if (!food) return;
    st.saveMyFood(food);
    setTray((x) => quickAdd(x, food, nextKey()));
    setQuery('');
  };

  // a new object each time, so the shared Toast restarts its 4 s
  const showToast = (text: string, undo: () => void, label = 'Undo') => setToast({ text, label, undo });
  const add = (d: Food) => { setTray((x) => quickAdd(x, d, nextKey())); setRefused({}); };
  const open = (d: Food) => setSheet({ item: newTrayItem(d, nextKey()), editing: false });
  const remove = (k: string) => {
    const prev = tray; const it = tray.find((x) => x.key === k); if (!it) return;
    setTray(tray.filter((x) => x.key !== k));
    showToast(`${compute(it).name} removed`, () => setTray(prev));
  };
  const commitSheet = (it: TrayItem) => {
    setTray((x) => (x.some((y) => y.key === it.key) ? x.map((y) => (y.key === it.key ? it : y)) : [...x, it]));
    setRefused((r) => { const { [it.key]: _, ...rest } = r; return rest; });
    setSheet(null);
  };
  const log = () => {
    if (!tray.length) return;
    const n = now(); const at = pickTime(time, n);
    const tr = timeReason(at, n);
    if (tr) { showToast(tr, () => setTimeOpen(true), 'Change'); return; }
    const built = buildEntries(tray, at, { now: n, newId: st.newId });
    if (built.refused.length) { setRefused(Object.fromEntries(built.refused.map((r) => [r.key, r.reason]))); return; }
    const bad = st.addEntries(built.entries);
    if (bad.length) { // same gate as buildEntries, so this should not happen; never leave a partial log
      for (const e of built.entries) if (!bad.some((b) => b.id === e.id)) st.deleteEntry(e.id);
      setRefused({ [tray[0].key]: bad[0].reason }); return;
    }
    const ids = built.entries.map((e) => e.id);
    st.showUndo(`Logged ${logLabel(ids.length, total.kcal).slice(4)}`, () => ids.forEach((id) => st.deleteEntry(id)));
    router.back();
  };

  const searchLine = focused ? t.c.honeyEdge : t.c.lineSoft;
  const rowFor = (d: Food) => {
    const u = defaultUnit(d), a = defaultAmount(d, u);
    const k = compute(newTrayItem(d, 'x', u, a)).kcal;
    const n = trayCount(tray, d), name = foodName(d), mine = isMine(d);
    // §6.3: Mine rows and names over 13 characters use two lines (name + tag, then the amount)
    const two = mine || name.length > 13;
    const tag = mine ? (
      <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={{ borderWidth: 1.5, borderColor: t.c.sageFill, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 0 }}>
        <T v="bodyStrong" style={{ color: t.c.trainText, fontSize: 14, lineHeight: 20 }}>Mine</T>
      </View>
    ) : null;
    return (
      <View key={foodId(d)} style={{ flexDirection: 'row', alignItems: 'center', minHeight: 64, paddingLeft: 16, paddingRight: 8 }}>
        <Pressable onPress={() => open(d)} accessibilityRole="button" accessibilityLabel={`${name}${mine ? ', my food' : ''}, ${amountLabel(u, a)}, ${kc(k)} kcal. Open details`}
          style={{ flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 56, gap: 6 }}>
          {two ? (
            <View style={{ flexShrink: 1, paddingVertical: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <T v="bodyStrong" style={{ fontSize: 17, flexShrink: 1 }} numberOfLines={1}>{name}</T>{tag}
              </View>
              <T tone="muted" style={{ fontSize: 15 }} numberOfLines={1}>{amountLabel(u, a)}</T>
            </View>
          ) : (
            <>
              <T v="bodyStrong" style={{ fontSize: 17, flexShrink: 1 }} numberOfLines={1}>{name}</T>
              <T tone="muted" style={{ fontSize: 15, flexShrink: 0 }} numberOfLines={1}>· {amountLabel(u, a)}</T>
            </>
          )}
          <View style={{ flex: 1 }} />
          <T v="number" style={{ fontSize: 18, marginRight: 8 }}>{kc(k)}</T>
        </Pressable>
        {n > 0 ? (
          <Pressable onPress={() => add(d)} accessibilityRole="button" accessibilityLabel={`${name}, in tray, ${amountLabel(u, n * a)}, add more`}
            style={{ minWidth: 56, height: 48, borderRadius: 24, borderWidth: 1.5, borderColor: t.c.sageFill, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingHorizontal: 10 }}>
            <T v="bodyStrong" style={{ color: t.c.trainText }}>×{n}</T><Icon name="plus" color={t.c.trainText} size={16} strokeWidth={2.4} />
          </Pressable>
        ) : (
          <Pressable onPress={() => add(d)} accessibilityRole="button" accessibilityLabel={`Add ${amountLabel(u, a)} ${name.toLowerCase()}`}
            style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: t.c.sheetTile, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="plus" color={t.c.text} size={20} strokeWidth={2.2} />
          </Pressable>
        )}
      </View>
    );
  };
  const card = { backgroundColor: t.c.card, borderRadius: t.radius.card, borderWidth: 1, borderColor: t.c.lineSoft, paddingVertical: 4 } as const;
  const trayRows = (
    <View style={card}>
      {tray.map((it) => {
        const c = compute(it), why = refused[it.key];
        const edited = c.kcalEdited || c.proteinEdited;
        const a11yEdit = c.kcalEdited && c.proteinEdited ? ', calories and protein edited' : c.kcalEdited ? ', calories edited' : c.proteinEdited ? ', protein edited' : '';
        return (
          <View key={it.key} style={{ paddingLeft: 16, paddingRight: 4 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 60 }}>
              <Pressable onPress={() => setSheet({ item: it, editing: true })} accessibilityRole="button"
                accessibilityLabel={`${c.name}, ${amountLabel(it.unit, it.amount)}, ${kc(c.kcal)} kcal${a11yEdit}. Edit`}
                style={{ flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 56, gap: 6 }}>
                <T v="bodyStrong" style={{ fontSize: 17, flexShrink: 1 }} numberOfLines={1}>{c.name}</T>
                <T tone="muted" style={{ fontSize: 15, flexShrink: 0 }} numberOfLines={1}>{amountLabel(it.unit, it.amount)}</T>
                <View style={{ flex: 1 }} />
                {edited ? (
                  <View importantForAccessibility="no-hide-descendants" style={{ borderWidth: 1, borderColor: t.c.stateLine, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 1, marginRight: 4 }}>
                    <T v="caption" tone="text2">edited</T>
                  </View>
                ) : null}
                <T v="number" style={{ fontSize: 18 }}>{kc(c.kcal)}</T>
              </Pressable>
              <Pressable onPress={() => remove(it.key)} accessibilityRole="button" accessibilityLabel={`Remove ${c.name}`}
                style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="x" color={t.c.text2} size={18} strokeWidth={2.2} />
              </Pressable>
            </View>
            {why ? <T v="caption" style={{ color: t.c.warn, marginTop: -6, marginBottom: 8 }} accessibilityLiveRegion="polite">{why}</T> : null}
          </View>
        );
      })}
    </View>
  );
  const chips = (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {tray.map((it) => {
        const c = compute(it);
        return (
          <View key={it.key} style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: t.c.card, borderWidth: 1, borderColor: refused[it.key] ? t.c.warn : t.c.lineSoft, borderRadius: 14, paddingLeft: 14 }}>
            <Pressable onPress={() => setSheet({ item: it, editing: true })} accessibilityRole="button" accessibilityLabel={`${c.name}, ${amountLabel(it.unit, it.amount)}, ${kc(c.kcal)} kcal. Edit`}
              style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center' }}>
              <T v="bodyStrong" style={{ fontSize: 15 }}>{c.name}</T><T tone="muted" style={{ fontSize: 15 }}> · {kc(c.kcal)}</T>
            </Pressable>
            <Pressable onPress={() => remove(it.key)} accessibilityRole="button" accessibilityLabel={`Remove ${c.name}`} style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="x" color={t.c.text2} size={16} strokeWidth={2.2} />
            </Pressable>
          </View>
        );
      })}
    </View>
  );

  const chip = chipLabel(time, now());
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.c.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={{ paddingTop: ins.top + 6, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', minHeight: 56 + ins.top }}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" style={{ width: 48, height: 48, marginLeft: -14, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="back" color={t.c.text} size={22} strokeWidth={2.2} />
        </Pressable>
        <T v="title" accessibilityRole="header" style={{ fontSize: 22, flex: 1 }}>Log food</T>
        <Pressable onPress={() => setTimeOpen(true)} accessibilityRole="button" accessibilityLabel={`When: ${chip}. Change`}
          style={{ minHeight: 48, justifyContent: 'center' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderColor: t.c.lineSoft, backgroundColor: t.c.card, borderRadius: 18, paddingHorizontal: 14, height: 36 }}>
            <T v="bodyStrong" style={{ fontSize: 14 }}>{chip}</T><Icon name="down" color={t.c.text} size={16} strokeWidth={2.2} />
          </View>
        </Pressable>
      </View>
      <View style={{ paddingHorizontal: 20, paddingTop: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', height: 56, borderRadius: 24, borderWidth: focused ? 2 : 1, borderColor: searchLine, backgroundColor: t.c.card, paddingLeft: focused ? 17 : 18, paddingRight: 4 }}>
          <Icon name="search" color={t.c.text2} size={20} strokeWidth={2} />
          <TextInput value={query} onChangeText={setQuery} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
            placeholder="Search food" placeholderTextColor={t.c.muted} accessibilityLabel="Search food" returnKeyType="search" autoCorrect={false}
            selectionColor={t.c.accentText}
            style={{ flex: 1, marginLeft: 12, color: t.c.text, ...t.type.body, fontSize: 17, lineHeight: 22, height: 52, outlineStyle: 'none' } as never} />
          {query ? (
            <Pressable onPress={() => setQuery('')} accessibilityRole="button" accessibilityLabel="Clear search" style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="x" color={t.c.text2} size={18} strokeWidth={2.2} />
            </Pressable>
          ) : (
            <Pressable onPress={() => router.push('/log')} accessibilityRole="button" accessibilityLabel="Type a sentence instead" style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="pencil" color={t.c.text2} size={19} strokeWidth={1.9} />
            </Pressable>
          )}
        </View>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 14, paddingBottom: 24, gap: 14 }} keyboardShouldPersistTaps="handled">
        {q ? (
          <>
            {results.length ? <View style={card}>{results.map(rowFor)}</View> : (
              <>
                <T v="bodyStrong" style={{ fontSize: 17, paddingTop: 4 }} accessibilityLiveRegion="polite">No match for “{q}”</T>
                <View style={{ backgroundColor: t.c.card, borderRadius: t.radius.card, borderWidth: 1, borderColor: t.c.lineSoft, paddingTop: 18 }}>
                  <T v="bodyStrong" accessibilityRole="header" style={{ fontSize: 17, paddingHorizontal: 20 }}>Add your own food</T>
                  <View style={{ paddingHorizontal: 20, paddingTop: 14, paddingBottom: 8 }}>
                    <FoodForm draft={own.draft} onChange={own.setDraft} errors={own.errors} clash={own.clash} focus={own.focus} onFocused={own.onFocused} card={false} />
                  </View>
                </View>
              </>
            )}
            {tray.length ? chips : null}
          </>
        ) : tray.length ? (
          <>
            <T v="caption" tone="text2" style={{ fontSize: 14, fontWeight: '600' }} accessibilityRole="header">Added</T>
            {trayRows}
          </>
        ) : (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginVertical: -12 }}>
              {recent.length ? <T v="caption" tone="text2" style={{ fontSize: 14, fontWeight: '600' }} accessibilityRole="header">Recent</T> : <View />}
              <Pressable onPress={() => router.push('/my-foods')} accessibilityRole="button" accessibilityLabel="My foods" style={{ minHeight: 48, justifyContent: 'center', paddingLeft: 12 }}>
                <T v="bodyStrong" tone="text2" style={{ fontSize: 14 }}>My foods ›</T>
              </Pressable>
            </View>
            {recent.length ? <View style={card}>{recent.map(rowFor)}</View> : null}
          </>
        )}
      </ScrollView>
      <Toast current={toast} text={toast?.text ?? ''} action={toast ? { label: toast.label, onPress: toast.undo } : undefined} onClose={() => setToast(null)}
        style={{ marginHorizontal: 20, marginBottom: 8, borderRadius: 14, backgroundColor: t.c.popBg, paddingLeft: 16 }} textColor={t.c.popText} actionColor={t.dark ? t.c.accentText : t.c.onNavPlus} />
      {noMatch ? (
        <View style={{ paddingHorizontal: 20, paddingTop: 4, paddingBottom: 10 + ins.bottom }}>
          <SaveButton title="Save and add" disabled={own.clash} onPress={saveAndAdd}
            a11y={own.clash ? 'Save and add. Unavailable: you already have this food'
              : `Save and add. Saves ${own.draft.name.trim().toLowerCase() || 'this food'} to My foods and adds ${amountLabel(own.draft.unit, Number(own.draft.amount) || 1)} to the tray`} />
          <T tone="muted" style={{ textAlign: 'center', fontSize: 13, marginTop: 6 }}>Saved to My foods</T>
        </View>
      ) : (
      <View style={{ paddingHorizontal: 20, paddingTop: 4, paddingBottom: 16 + ins.bottom }}>
        <Pressable onPress={log} disabled={!tray.length} accessibilityRole="button" accessibilityState={{ disabled: !tray.length }}
          accessibilityLabel={tray.length ? logLabel(tray.length, total.kcal) : 'Log food'}
          style={{ height: 56, borderRadius: t.radius.button, alignItems: 'center', justifyContent: 'center', flexDirection: 'row',
            backgroundColor: tray.length ? t.c.accentFill : t.c.sheetTile, borderWidth: tray.length && !t.dark ? 1.5 : 0, borderColor: t.c.honeyEdge }}>
          {tray.length ? (
            <T v="bodyStrong" style={{ fontSize: 17, color: t.c.onAccent }}>{logLabel(tray.length, total.kcal).split(' · ')[0]}<T style={{ fontSize: 17, color: t.c.onAccent }}> · {kc(total.kcal)} kcal</T></T>
          ) : <T v="bodyStrong" tone="muted" style={{ fontSize: 17 }}>Log food</T>}
        </Pressable>
      </View>
      )}
      {sheet ? <ItemSheet item={sheet.item} editing={sheet.editing} onClose={() => setSheet(null)} onDone={commitSheet} /> : null}
      <TimeSheet visible={timeOpen} value={time} now={now} onClose={() => setTimeOpen(false)} onPick={(p) => { setTime(p); setTimeOpen(false); }} />
    </KeyboardAvoidingView>
  );
}
