// How-to page (build-plan item 8, spec §9.3 rework order, placeholder state lib-detail-nodemo): demo slot reserved at its
// drawn size with the calm dashed "Demo coming soon" panel (no clips, no third-party art), the muscles card (text legend;
// the drawn map waits for approved artwork, Q23), "How to do it" steps from the source, the credit line under the steps
// (no demo yet), and the video row only when the row has a video. "Add to routine" arrives with plans (item 9).
import { useRouter } from 'expo-router';
import { Linking, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { T } from '@/components/ui';
import { exercises, type ExerciseRepo } from '@/lib/exercises';
import { useTheme } from '@/theme';
import { creditLine, DEMO_LINE, DEMO_TITLE, legend, metaLine, muscleLabel } from './model';

/** Demo area as drawn in ht-playing / ht-stopped (424 × 393 at 390dp wide). */
export const DEMO_ASPECT = 424 / 393;

export function ExerciseScreen({ id, repo = exercises }: { id: string; repo?: ExerciseRepo }) {
  const t = useTheme(); const ins = useSafeAreaInsets(); const router = useRouter();
  const e = repo.byId(id);
  const back = (
    <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" style={{ width: 48, height: 48, marginLeft: -14, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name="back" color={t.c.text} size={22} strokeWidth={2.2} />
    </Pressable>
  );
  if (!e) {
    return (
      <View style={{ flex: 1, backgroundColor: t.c.bg, paddingTop: ins.top + 6, paddingHorizontal: 20 }}>
        {back}
        <T tone="text2" style={{ marginTop: 12 }}>This exercise isn’t in the library.</T>
      </View>
    );
  }
  const l = legend(e);
  const credit = creditLine(e);
  const swatch = (primary: boolean) => (
    <View style={{ width: 16, height: 16, borderRadius: 4, marginTop: 3, backgroundColor: primary ? t.c.mapPrimary : t.c.mapSecondary, borderWidth: primary ? 0 : 1.6, borderColor: t.c.mapOutline }} />
  );
  return (
    <View style={{ flex: 1, backgroundColor: t.c.bg }}>
      <View style={{ paddingTop: ins.top + 6, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', minHeight: 56 + ins.top, gap: 8 }}>
        {back}
        <T v="title" accessibilityRole="header" style={{ fontSize: 22, flex: 1 }} numberOfLines={2}>{e.name}</T>
        <T tone="text2" style={{ fontSize: 15 }}>{metaLine(e)}</T>
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: t.sizes.nav + 40, gap: 18 }}>
        <View testID="demo-slot" accessible accessibilityLabel={`${DEMO_TITLE}. ${DEMO_LINE}`}
          style={{ aspectRatio: DEMO_ASPECT, borderRadius: t.radius.card, borderWidth: 1.5, borderStyle: 'dashed', borderColor: t.c.stateLine, backgroundColor: t.c.sheetTile,
            alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, gap: 6 }}>
          <Icon name="today" color={t.c.text2} size={26} strokeWidth={1.8} />
          <T v="bodyStrong" style={{ fontSize: 18, marginTop: 6 }}>{DEMO_TITLE}</T>
          <T tone="text2" style={{ fontSize: 15, textAlign: 'center' }}>{DEMO_LINE}</T>
        </View>
        <View accessible accessibilityRole="image" accessibilityLabel={muscleLabel(e)}
          style={{ backgroundColor: t.c.card, borderRadius: t.radius.card, borderWidth: 1, borderColor: t.c.lineSoft, padding: 20, gap: 10 }}>
          <T v="bodyStrong" style={{ fontSize: 17 }}>Muscles worked</T>
          <View style={{ flexDirection: 'row', gap: 10 }}>{swatch(true)}<T style={{ flex: 1, fontSize: 16 }}><T v="bodyStrong" style={{ fontSize: 16 }}>Primary: </T>{l.primary}</T></View>
          {l.secondary ? <View style={{ flexDirection: 'row', gap: 10 }}>{swatch(false)}<T style={{ flex: 1, fontSize: 16 }}><T v="bodyStrong" style={{ fontSize: 16 }}>Secondary: </T>{l.secondary}</T></View> : null}
        </View>
        <View style={{ gap: 14 }}>
          <T v="bodyStrong" accessibilityRole="header" style={{ fontSize: 17 }}>How to do it</T>
          {e.steps.map((s, i) => (
            <View key={i} style={{ flexDirection: 'row', gap: 14 }} accessible accessibilityLabel={`Step ${i + 1}. ${s}`}>
              <View style={{ width: 28, height: 28, borderRadius: 14, borderWidth: 1.5, borderColor: t.c.text2, alignItems: 'center', justifyContent: 'center' }}>
                <T v="bodyStrong" style={{ fontSize: 14 }}>{i + 1}</T>
              </View>
              <T style={{ flex: 1, fontSize: 16, lineHeight: 23 }}>{s}</T>
            </View>
          ))}
          {credit ? (
            <Pressable onPress={() => { void Linking.openURL(e.source_ref).catch(() => {}); }} accessibilityRole="link" accessibilityLabel={`${credit}. Opens wger.de`}>
              <T tone="muted" style={{ fontSize: 13, lineHeight: 18 }}>{credit}</T>
            </Pressable>
          ) : null}
        </View>
        {e.video_url ? (
          <Pressable onPress={() => { void Linking.openURL(e.video_url!).catch(() => {}); }} accessibilityRole="link" accessibilityLabel={`Watch a video on YouTube${e.video_channel ? `, ${e.video_channel}` : ''}`}
            style={{ backgroundColor: t.c.card, borderRadius: t.radius.card, borderWidth: 1, borderColor: t.c.lineSoft, padding: 18, flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ flex: 1 }}><T v="bodyStrong" style={{ fontSize: 17 }}>Watch a video</T><T tone="text2">YouTube{e.video_channel ? ` · ${e.video_channel}` : ''}</T></View>
            <Icon name="chevron" color={t.c.text2} size={18} strokeWidth={2.2} />
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}
