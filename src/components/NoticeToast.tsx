// The app-wide toasts above the nav: a one-time notice from the store (e.g. "This entry was deleted on another device.",
// OK, 5 s) and the store's Undo toast (Log food "Logged N items · Undo", timeline "Removed X · Undo", 4 s, Q8). Both use
// the shared Toast: a touch restarts the time, and with a screen reader on they stay until dismissed. Never persisted.
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useStore } from '../lib/store';
import { makeStyles, useTheme } from '../theme';
import { Toast, TOAST_MS } from './Toast';

export const NOTICE_MS = 5000;
/** Q8: undo toasts stay 4 s. */
export const UNDO_MS = TOAST_MS;
export function NoticeToast() {
  const st = useStore(); const t = useTheme(); const s = useStyles(); const ins = useSafeAreaInsets();
  const { notice, dismissNotice, undoToast, dismissUndo } = st;
  const style = [s.toast, { bottom: ins.bottom + t.sizes.nav + 28 }];
  if (notice) return <Toast current={notice} text={notice} onClose={dismissNotice} ms={NOTICE_MS} style={style} textColor={t.c.text} actionColor={t.c.em} />;
  if (!undoToast) return null;
  return <Toast current={undoToast} text={undoToast.text} action={{ label: 'Undo', onPress: undoToast.undo }} onClose={dismissUndo} ms={UNDO_MS} style={style} textColor={t.c.text} actionColor={t.c.em} />;
}
const useStyles = makeStyles((t) => ({
  toast: { position: 'absolute', left: 16, right: 16, ...t.elev.e1, gap: 8, borderRadius: 14, borderWidth: 1, borderColor: t.c.cardLine, backgroundColor: t.c.card, paddingLeft: 14 },
}));
