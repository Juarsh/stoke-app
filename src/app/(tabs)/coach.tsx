// v3.2 frame 11: "Left for today" hero (big numbers) + picks as separate item cards with food-icon tiles and coral "+ Log".
import { useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';
import { FoodTile } from '@/components/FoodTile';
import { Card, Row, Screen, T } from '@/components/ui';
import type { Suggestion } from '@/lib/coach';
import { grams as g, kc } from '@/lib/format';
import { useDay } from '@/lib/useDay';
import { makeStyles, useTheme } from '@/theme';


export default function Coach() {
  const d = useDay(); const t = useTheme(); const s = useStyles(); const router = useRouter();
  const diet = d.profile?.diet === 'veg' ? 'Veg' : d.profile?.diet === 'egg' ? 'Egg + veg' : 'Veg and non-veg';
  const log = (p: Suggestion) => router.push({ pathname: '/log', params: { prefill: p.label } });
  const left = Math.max(0, d.kcalLeft), pLeft = Math.max(0, d.proteinLeft);
  return (
    <Screen title="Coach">
      <View style={s.hero} accessible accessibilityLabel={`Left for today: ${kc(left)} calories, ${Math.round(pLeft)} grams protein`}>
        <Row style={{ gap: 6 }}><T tone={t.dark ? 'goldOnGrad' : 'accentText'}>✦</T><T v="bodyStrong">Left for today</T></Row>
        <Row style={{ alignItems: 'baseline', gap: 4, flexWrap: 'wrap' }}>
          <T v="displayM" style={{ fontSize: 44, lineHeight: 48 }}>{kc(left)}</T><T tone="text2">kcal ·</T>
          <T v="displayM" style={{ fontSize: 28, lineHeight: 32 }}>{g(pLeft)}</T><T tone="text2">protein</T>
        </Row>
        <T v="caption" tone="text2">{diet} picks from our dish table · estimates</T>
      </View>
      {left > 0 ? d.picks.map((p) => (
        <Card key={p.dish.id}>
          <Row style={{ gap: 12 }}>
            <FoodTile seed={p.dish.id} category={p.dish.category} size={44} />
            <View style={{ flex: 1 }}>
              <T v="bodyStrong">{p.label}</T>
              <T v="caption" tone="muted">≈ {kc(p.kcal)} kcal · ≈ {g(p.protein)} protein</T>
            </View>
            <Pressable onPress={() => log(p)} accessibilityRole="button" accessibilityLabel={`Log ${p.label}, about ${kc(p.kcal)} calories`} hitSlop={8} style={{ padding: 8 }}>
              <T v="bodyStrong" tone="em">+ Log</T>
            </Pressable>
          </Row>
        </Card>
      )) : <Card><T tone="text2">You’re at your target for today.</T></Card>}
      <T v="caption" tone="muted">After 3 days over target, picks lean lighter. No warnings.</T>
    </Screen>
  );
}
const useStyles = makeStyles((t) => ({
  hero: { backgroundColor: t.c.accentTint, borderRadius: t.radius.card, borderWidth: 1, borderColor: t.c.emTintLine, padding: t.space.cardH, gap: 4 },
}));
