// The habit toast (§7.3, Q8/Q9): ink, above the nav on the tabs, "Push-ups done · Undo · Change" (Change only for count
// and sets habits) or "Water undone · Undo"; 4 s, a touch restarts it, it stays with a screen reader on. Undo puts the
// day back as it was. Change opens the amount sheet for that day. Mounted once, next to the app-wide NoticeToast.
import { useSegments } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TOAST_MS, useToastTimer } from '@/components/Toast';
import { T } from '@/components/ui';
import { useHabits } from '@/lib/habits';
import { useLogDay } from '@/lib/useLogDay';
import { useTheme } from '@/theme';
import { AmountSheet } from './AmountSheet';

export function HabitToastHost() {
  const hb = useHabits(); const t = useTheme(); const ins = useSafeAreaInsets(); const seg = useSegments() as string[]; const today = useLogDay();
  const cur = hb.toast;
  const [sheet, setSheet] = useState<{ id: string; date: string } | null>(null);
  const { touch } = useToastTimer(cur, hb.closeToast, TOAST_MS);
  const inTabs = seg[0] === '(tabs)';
  const btn = (label: string, a11y: string, onPress: () => void) => (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={a11y} style={{ minWidth: 64, minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 }}>
      <T v="bodyStrong" style={{ color: t.c.accentFill, fontSize: 17 }}>{label}</T>
    </Pressable>
  );
  return (
    <>
      {cur ? (
        <View testID="toast-habit" onTouchStart={touch} accessibilityLiveRegion="polite" accessibilityRole="alert"
          style={{ position: 'absolute', left: 16, right: 16, bottom: ins.bottom + (inTabs ? t.sizes.nav + 16 : 16), backgroundColor: t.c.ink, borderRadius: 18,
            flexDirection: 'row', alignItems: 'center', paddingLeft: 20, paddingRight: 6, minHeight: 64, ...t.elev.e3 }}>
          <T v="bodyStrong" style={{ flex: 1, color: t.c.inkText, fontSize: 17 }}>{cur.text}</T>
          {btn('Undo', `Undo, ${cur.text}`, () => { hb.undo(cur); hb.closeToast(); })}
          {cur.change ? btn('Change', 'Change amount', () => { setSheet({ id: cur.habitId, date: cur.date }); hb.closeToast(); }) : null}
        </View>
      ) : null}
      {sheet ? <AmountSheet habitId={sheet.id} date={sheet.date} today={today} onClose={() => setSheet(null)} /> : null}
    </>
  );
}
