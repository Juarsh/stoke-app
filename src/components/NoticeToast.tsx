// One-time notice from the store (e.g. "This entry was deleted on another device."): the Coach undo-toast pattern,
// above the nav, polite live region, gone after 5 s or on OK. Never persisted, so it shows once.
import { useEffect } from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStore } from '../lib/store';
import { makeStyles, useTheme } from '../theme';
import { T } from './ui';

export const NOTICE_MS = 5000;
/** Q8: undo toasts stay 4 s. */
export const UNDO_MS = 4000;
export function NoticeToast() {
  const st = useStore(); const t = useTheme(); const s = useStyles(); const ins = useSafeAreaInsets();
  const { notice, dismissNotice } = st;
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(dismissNotice, NOTICE_MS);
    return () => clearTimeout(id);
  }, [notice, dismissNotice]);
  const { undoToast, dismissUndo } = st;
  useEffect(() => {
    if (!undoToast) return;
    const id = setTimeout(dismissUndo, UNDO_MS);
    return () => clearTimeout(id);
  }, [undoToast, dismissUndo]);
  if (!notice && undoToast) {
    return (
      <View style={[s.toast, { bottom: ins.bottom + t.sizes.nav + 28 }]} accessibilityLiveRegion="polite" accessibilityRole="alert">
        <T tone="text" style={{ flex: 1, paddingVertical: 12 }}>{undoToast.text}</T>
        <Pressable onPress={() => { undoToast.undo(); dismissUndo(); }} accessibilityRole="button" accessibilityLabel="Undo" style={s.ok}><T v="bodyStrong" tone="em">Undo</T></Pressable>
      </View>
    );
  }
  if (!notice) return null;
  return (
    <View style={[s.toast, { bottom: ins.bottom + t.sizes.nav + 28 }]} accessibilityLiveRegion="polite" accessibilityRole="alert">
      <T tone="text" style={{ flex: 1, paddingVertical: 12 }}>{notice}</T>
      <Pressable onPress={dismissNotice} accessibilityRole="button" accessibilityLabel="Dismiss" style={s.ok}><T v="bodyStrong" tone="em">OK</T></Pressable>
    </View>
  );
}
const useStyles = makeStyles((t) => ({
  toast: { position: 'absolute', left: 16, right: 16, ...t.elev.e1, flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 14, borderWidth: 1, borderColor: t.c.cardLine, backgroundColor: t.c.card, paddingLeft: 14 },
  ok: { minHeight: 44, minWidth: 64, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
}));
