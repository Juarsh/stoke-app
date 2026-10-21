// Choose a plan (item 9; workouts 2-weekly-split-empty restyled to full-b2 tokens, Q29): three starter splits
// (Push · Pull · Legs is pre-selected and tagged Popular), "Use <plan>", or "Build my own routine" (an empty week).
// Reached from Home "Choose a plan" and Train "+ New plan". A template is a starting point: every exercise can change.
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { T } from '@/components/ui';
import { usePlans } from '@/lib/plans';
import { useTheme } from '@/theme';
import { TEMPLATES } from './model';
import { Header, HoneyButton, TextLink } from './parts';

export function ChoosePlanScreen() {
  const t = useTheme(); const router = useRouter(); const plans = usePlans();
  const [pick, setPick] = useState(TEMPLATES[0].key);
  const tpl = TEMPLATES.find((x) => x.key === pick)!;
  const use = () => { plans.applyTemplate(pick); router.back(); };
  const own = () => { const p = plans.newPlan(); router.replace({ pathname: '/train/plan/[id]', params: { id: p.id } } as never); };
  return (
    <View style={{ flex: 1, backgroundColor: t.c.bg }}>
      <Header title="Choose a plan" />
      <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 4, gap: 14, paddingBottom: 40 }}>
        <View style={{ backgroundColor: t.c.card, borderRadius: t.radius.card, borderWidth: 1, borderColor: t.c.lineSoft, padding: 18, gap: 12 }}>
          <T v="title" accessibilityRole="header" style={{ fontSize: 22 }}>Plan your week</T>
          <T tone="text2" style={{ fontSize: 15, lineHeight: 22 }}>Pick a split and we’ll set up the routines. You can change every exercise later.</T>
          <View accessibilityRole="radiogroup" style={{ gap: 10 }}>
            {TEMPLATES.map((x) => {
              const on = x.key === pick;
              return (
                <Pressable key={x.key} onPress={() => setPick(x.key)} accessibilityRole="radio" accessibilityState={{ selected: on }}
                  accessibilityLabel={`${x.name}${x.popular ? ', popular' : ''}. ${x.sub.replace('…', '')}`}
                  style={{ borderRadius: 16, borderWidth: on ? 2 : 1, borderColor: on ? t.c.honeyEdge : t.c.lineSoft, backgroundColor: on ? t.c.accentTint : t.c.card, padding: on ? 15 : 16, gap: 2, minHeight: 64 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <T v="bodyStrong" style={{ fontSize: 17, flex: 1 }}>{x.name}</T>
                    {x.popular ? <View style={{ backgroundColor: on ? t.c.card : t.c.accentTint, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 }}><T v="eyebrow" style={{ color: t.c.accentText, fontSize: 12 }}>Popular</T></View> : null}
                  </View>
                  <T tone="text2" style={{ fontSize: 14 }}>{x.sub}</T>
                </Pressable>
              );
            })}
          </View>
          <View style={{ marginTop: 4 }}><HoneyButton title={`Use ${tpl.name}`} onPress={use} disabled={!plans.ready} /></View>
        </View>
        <View style={{ alignItems: 'center' }}>
          <TextLink title="Build my own routine" onPress={own} />
        </View>
      </ScrollView>
    </View>
  );
}
