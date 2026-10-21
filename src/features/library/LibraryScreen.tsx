// Exercises list (build-plan item 8, spec §9.2, frames lib-list / lib-filtered / lib-noresult): search over name and alias,
// Equipment ▾ pinned left then scrolling muscle chips (active = dark fill), results line with Clear filters, A–Z list,
// first-time hint card. Recent, Yours and custom exercises / requests come with the logger and later items.
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { T } from '@/components/ui';
import { exercises, type Exercise, type ExerciseRepo } from '@/lib/exercises';
import { useStore } from '@/lib/store';
import { useTheme } from '@/theme';
import { ExerciseRow } from './ExerciseRow';
import { closest, equipmentOf, filtered, Filters, GROUPS, HINT, NO_FILTERS, resultsLine, search, words } from './model';

export function LibraryScreen({ repo = exercises }: { repo?: ExerciseRepo }) {
  const t = useTheme(); const ins = useSafeAreaInsets(); const router = useRouter(); const st = useStore();
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const [eqOpen, setEqOpen] = useState(false);
  const rows = useMemo(() => search(repo, query, f), [repo, query, f]);
  const equipment = useMemo(() => equipmentOf(repo), [repo]);
  const q = words(query).length > 0;
  const none = q && !rows.length;
  const near = useMemo(() => (none ? closest(repo, query) : []), [none, repo, query]);
  const open = (e: Exercise) => router.push({ pathname: '/train/exercise/[id]', params: { id: e.id } });
  const on = (x: boolean) => ({ bg: x ? (t.dark ? t.c.inkText : t.c.ink) : 'transparent', fg: x ? (t.dark ? t.c.ink : t.c.inkText) : t.c.text });

  const chip = (g: Filters['group']) => {
    const sel = f.group === g, c = on(sel);
    return (
      <Pressable key={g} onPress={() => setF({ ...f, group: g })} accessibilityRole="radio" accessibilityState={{ selected: sel }} accessibilityLabel={g === 'All' ? 'All muscles' : `Muscle: ${g}`}
        style={{ minHeight: 48, justifyContent: 'center' }}>
        <View style={{ height: 38, paddingHorizontal: 16, borderRadius: 19, justifyContent: 'center', backgroundColor: c.bg, borderWidth: sel ? 0 : 1, borderColor: t.c.line }}>
          <T v="bodyStrong" style={{ fontSize: 15, color: c.fg }}>{g}</T>
        </View>
      </Pressable>
    );
  };
  const eqOn = on(!!f.equipment);
  const filterRow = (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <Pressable onPress={() => setEqOpen(true)} accessibilityRole="button" accessibilityLabel={`Equipment: ${f.equipment ?? 'any'}. Change`} style={{ minHeight: 48, justifyContent: 'center' }}>
        <View style={{ height: 44, paddingHorizontal: 14, borderRadius: 12, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: eqOn.bg, borderWidth: f.equipment ? 0 : 1.5, borderColor: t.c.stateLine }}>
          <T v="bodyStrong" style={{ fontSize: 15, color: eqOn.fg }}>{f.equipment ?? 'Equipment'}</T>
          <Icon name="down" color={eqOn.fg} size={16} strokeWidth={2.2} />
        </View>
      </Pressable>
      <View style={{ width: 1, height: 28, backgroundColor: t.c.line, marginHorizontal: 10 }} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} accessibilityRole="radiogroup" accessibilityLabel="Muscle" contentContainerStyle={{ gap: 8, paddingRight: 20 }}>
        {GROUPS.map(chip)}
      </ScrollView>
    </View>
  );
  const card = { backgroundColor: t.c.card, borderRadius: t.radius.card, borderWidth: 1, borderColor: t.c.lineSoft, overflow: 'hidden' } as const;
  const header = (
    <View style={{ gap: 12, paddingBottom: 10 }}>
      {filterRow}
      {filtered(f) && !none ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <T style={{ fontSize: 15, flex: 1 }} accessibilityLiveRegion="polite">
            <T v="bodyStrong" style={{ fontSize: 15 }}>{resultsLine(rows.length, NO_FILTERS)}</T>{resultsLine(rows.length, f).slice(resultsLine(rows.length, NO_FILTERS).length)}
          </T>
          <Pressable onPress={() => setF(NO_FILTERS)} accessibilityRole="button" accessibilityLabel="Clear filters" style={{ minHeight: 48, justifyContent: 'center', paddingLeft: 12 }}>
            <T v="bodyStrong" style={{ fontSize: 15, color: t.c.accentText }}>Clear filters</T>
          </Pressable>
        </View>
      ) : null}
      {!st.libraryHintDone && !q && !filtered(f) ? (
        <View style={[card, { flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingVertical: 6 }]}>
          <T tone="text2" style={{ flex: 1, fontSize: 15, lineHeight: 21, paddingVertical: 8 }}>{HINT}</T>
          <Pressable onPress={st.dismissLibraryHint} accessibilityRole="button" accessibilityLabel="Dismiss hint" style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="x" color={t.c.text2} size={18} strokeWidth={2.2} />
          </Pressable>
        </View>
      ) : null}
      {!q && !filtered(f) ? (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
          <T v="bodyStrong" accessibilityRole="header" style={{ fontSize: 16 }}>All exercises</T>
          <T tone="muted" style={{ fontSize: 14 }}>A–Z</T>
        </View>
      ) : null}
    </View>
  );
  const noResult = (
    <View style={{ gap: 6, paddingTop: 8 }}>
      <T v="title" style={{ fontSize: 22, textAlign: 'center' }} accessibilityLiveRegion="polite">No match for “{query.trim()}”</T>
      <T tone="text2" style={{ textAlign: 'center' }}>Check the spelling.</T>
      {filtered(f) ? (
        <Pressable onPress={() => setF(NO_FILTERS)} accessibilityRole="button" accessibilityLabel="Clear filters" style={{ minHeight: 48, alignItems: 'center', justifyContent: 'center' }}>
          <T v="bodyStrong" style={{ color: t.c.accentText }}>Clear filters</T>
        </Pressable>
      ) : null}
      {near.length ? (
        <>
          <T v="bodyStrong" accessibilityRole="header" style={{ fontSize: 16, marginTop: 18, marginBottom: 6 }}>Closest in the library</T>
          <View style={card}>{near.map((e, i) => <ExerciseRow key={e.id} e={e} first={i === 0} onPress={() => open(e)} />)}</View>
        </>
      ) : null}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: t.c.bg }}>
      <View style={{ paddingTop: ins.top + 6, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', minHeight: 56 + ins.top }}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" style={{ width: 48, height: 48, marginLeft: -14, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="back" color={t.c.text} size={22} strokeWidth={2.2} />
        </Pressable>
        <T v="title" accessibilityRole="header" style={{ fontSize: 22, flex: 1 }}>Exercises</T>
      </View>
      <View style={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', height: 56, borderRadius: 16, borderWidth: focused ? 2 : 1.5, borderColor: focused ? t.c.text : t.c.stateLine,
          backgroundColor: t.c.card, paddingLeft: focused ? 17 : 17.5, paddingRight: 4 }}>
          <Icon name="search" color={t.c.text2} size={20} strokeWidth={2} />
          <TextInput value={query} onChangeText={setQuery} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} placeholder="Search exercises" placeholderTextColor={t.c.muted}
            accessibilityLabel="Search exercises" returnKeyType="search" autoCorrect={false} selectionColor={t.c.accentText}
            style={{ flex: 1, marginLeft: 12, color: t.c.text, ...t.type.body, fontSize: 17, lineHeight: 22, height: 52, outlineStyle: 'none' } as never} />
          {query ? (
            <Pressable onPress={() => setQuery('')} accessibilityRole="button" accessibilityLabel="Clear search" style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="x" color={t.c.text2} size={18} strokeWidth={2.2} />
            </Pressable>
          ) : null}
        </View>
      </View>
      <FlatList data={none ? [] : rows} keyExtractor={(e) => e.id} keyboardShouldPersistTaps="handled" initialNumToRender={14}
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 6, paddingBottom: t.sizes.nav + 40 }}
        ListHeaderComponent={header} ListEmptyComponent={none ? noResult : null}
        renderItem={({ item, index }) => (
          <View style={{ backgroundColor: t.c.card, borderColor: t.c.lineSoft, borderLeftWidth: 1, borderRightWidth: 1, borderTopWidth: index === 0 ? 1 : 0,
            borderBottomWidth: index === rows.length - 1 ? 1 : 0, borderTopLeftRadius: index === 0 ? t.radius.card : 0, borderTopRightRadius: index === 0 ? t.radius.card : 0,
            borderBottomLeftRadius: index === rows.length - 1 ? t.radius.card : 0, borderBottomRightRadius: index === rows.length - 1 ? t.radius.card : 0 }}>
            <ExerciseRow e={item} first={index === 0} onPress={() => open(item)} />
          </View>
        )} />
      <Modal visible={eqOpen} transparent animationType="slide" onRequestClose={() => setEqOpen(false)}>
        <Pressable style={{ flex: 1, backgroundColor: t.c.scrim }} onPress={() => setEqOpen(false)} accessibilityLabel="Close" />
        <View accessibilityViewIsModal style={{ backgroundColor: t.c.sheet, borderTopLeftRadius: t.radius.sheet, borderTopRightRadius: t.radius.sheet, paddingHorizontal: 24, paddingTop: 10,
          paddingBottom: 20 + ins.bottom, ...(t.dark ? { borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)' } : {}) }}>
          <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: t.c.handle, alignSelf: 'center', marginBottom: 14 }} />
          <T v="title" accessibilityRole="header" style={{ fontSize: 22, marginBottom: 6 }}>Equipment</T>
          {[null, ...equipment].map((x) => {
            const sel = f.equipment === x;
            return (
              <Pressable key={x ?? 'any'} onPress={() => { setF({ ...f, equipment: x }); setEqOpen(false); }} accessibilityRole="radio" accessibilityState={{ selected: sel }}
                accessibilityLabel={x ?? 'Any equipment'} style={{ flexDirection: 'row', alignItems: 'center', minHeight: 52, borderTopWidth: 1, borderTopColor: t.c.sheetLine }}>
                <T v={sel ? 'bodyStrong' : 'body'} style={{ fontSize: 17, flex: 1 }}>{x ?? 'Any equipment'}</T>
                {sel ? <T v="bodyStrong" style={{ fontSize: 18 }}>✓</T> : null}
              </Pressable>
            );
          })}
        </View>
      </Modal>
    </View>
  );
}
