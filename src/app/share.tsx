import * as Sharing from 'expo-sharing';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Share, Switch, View } from 'react-native';
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';
import { captureRef } from 'react-native-view-shot';
import { Button, Row, Screen, Segmented, T } from '@/components/ui';
import { brand } from '@/lib/config';
import { useStore } from '@/lib/store';
import { useDay } from '@/lib/useDay';
import { useTheme } from '@/theme';

/** Share card rendered as a view, captured to PNG with react-native-view-shot, then shared. 9:16 (WhatsApp status). */
export default function ShareScreen() {
  const t = useTheme(); const st = useStore(); const d = useDay(); const router = useRouter();
  const ref = useRef<View>(null);
  const [kind, setKind] = useState<'day' | 'streak'>('streak');
  const [showKcal, setShowKcal] = useState(st.profile?.showKcalOnCards ?? true);
  async function share() {
    const uri = await captureRef(ref, { format: 'png', quality: 1, width: 1080, height: 1920, result: 'tmpfile' });
    if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: 'Share' });
    else await Share.share({ url: uri, message: `${brand.name}` });
  }
  const W = 270, H = 480;
  return (
    <Screen title="Share today" right={<Button kind="ghost" title="Close" onPress={() => router.back()} />}>
      <View style={{ alignItems: 'center' }}>
        <View ref={ref} collapsable={false} style={{ width: W, height: H, borderRadius: t.radius.card, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          <Svg width={W} height={H} style={{ position: 'absolute' }}>
            <Defs><LinearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><Stop offset="0" stopColor={t.c.shareBgStart} /><Stop offset="1" stopColor={t.c.shareBgEnd} /></LinearGradient></Defs>
            <Rect width={W} height={H} fill="url(#bg)" />
            <Defs><RadialGradient id="sg" cx="0%" cy="0%" rx="90%" ry="60%"><Stop offset="0" stopColor={t.c.glow1} /><Stop offset="1" stopColor={t.c.glow1} stopOpacity={0} /></RadialGradient></Defs>
            <Rect width={W} height={H} fill="url(#sg)" />
          </Svg>
          {kind === 'streak' ? (
            <>
              <T style={{ fontSize: 56, lineHeight: 64 }}>🔥</T>
              <T v="displayXl" tone="gold">Day {d.streak.current}</T>
              <T tone="text2">streak of logging every day</T>
            </>
          ) : (
            <>
              <T v="headline">Today</T>
              {showKcal ? <T v="display" tone="em">{d.tot.kcal} kcal</T> : null}
              <T v="headline" tone="gold">{d.tot.protein} g protein</T>
              <T tone="text2">🔥 {d.streak.current}-day streak</T>
            </>
          )}
          <T v="caption" tone="muted" style={{ position: 'absolute', bottom: 16 }}>{brand.name}</T>
        </View>
      </View>
      <Segmented value={kind} onChange={setKind} options={[{ value: 'day', label: 'Day card' }, { value: 'streak', label: 'Streak card' }]} />
      <Row style={{ justifyContent: 'space-between', minHeight: 48 }}>
        <T>Show calories on card</T>
        <Switch value={showKcal} onValueChange={setShowKcal} trackColor={{ true: t.c.primary, false: t.c.surface3 }} thumbColor={t.c.surface} />
      </Row>
      <Button title="Share to WhatsApp ↗" onPress={() => share().catch(() => {})} />
    </Screen>
  );
}
