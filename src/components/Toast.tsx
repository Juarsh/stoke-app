// Toasts (spec §2, §6.6, §15, Q8): one 4 s timer that any touch on the toast restarts; with TalkBack (or another screen
// reader) on, the toast stays until it's dismissed and shows a ✕. Polite live region; its action (Undo / Change) and
// Dismiss are also exposed as accessibility actions. Every button is 48dp.
import { ReactNode, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleProp, View, ViewStyle } from 'react-native';
import { Icon } from './Icon';
import { T } from './ui';

/** Q8: toasts stay 4 s (restarted by a touch). */
export const TOAST_MS = 4000;

export function useScreenReader() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isScreenReaderEnabled?.().then((v) => { if (live) setOn(!!v); }).catch(() => {});
    const sub = AccessibilityInfo.addEventListener?.('screenReaderChanged', (v: boolean) => setOn(!!v));
    return () => { live = false; sub?.remove?.(); };
  }, []);
  return on;
}

/** Closes `current` after ms, unless a screen reader is on. touch() restarts the time; a new `current` starts it again. */
export function useToastTimer(current: unknown, onExpire: () => void, ms = TOAST_MS) {
  const screenReader = useScreenReader();
  const [touches, setTouches] = useState(0);
  const cb = useRef(onExpire); cb.current = onExpire;
  useEffect(() => {
    if (!current || screenReader) return;
    const id = setTimeout(() => cb.current(), ms);
    return () => clearTimeout(id);
  }, [current, screenReader, touches, ms]);
  return { screenReader, touch: () => setTouches((n) => n + 1) };
}

export interface ToastProps {
  /** the toast being shown (a new object restarts the timer); null hides it */
  current: unknown;
  text: string;
  action?: { label: string; a11y?: string; onPress: () => void };
  onClose: () => void;
  ms?: number;
  style: StyleProp<ViewStyle>;
  textColor: string; actionColor: string;
  children?: ReactNode;
}
export function Toast({ current, text, action, onClose, ms, style, textColor, actionColor }: ToastProps) {
  const { screenReader, touch } = useToastTimer(current, onClose, ms);
  if (!current) return null;
  const act = () => { action?.onPress(); onClose(); };
  return (
    <View testID="toast" style={[{ flexDirection: 'row', alignItems: 'center' }, style]} onTouchStart={touch}
      accessibilityLiveRegion="polite" accessibilityRole="alert"
      accessibilityActions={[...(action ? [{ name: 'activate', label: action.label }] : []), { name: 'escape', label: 'Dismiss' }]}
      onAccessibilityAction={(e) => { if (e.nativeEvent.actionName === 'activate') act(); else onClose(); }}>
      <T style={{ flex: 1, color: textColor, paddingVertical: 12 }}>{text}</T>
      {action ? (
        <Pressable onPress={act} accessibilityRole="button" accessibilityLabel={action.a11y ?? action.label}
          style={{ minWidth: 64, minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 }}>
          <T v="bodyStrong" style={{ color: actionColor }}>{action.label}</T>
        </Pressable>
      ) : null}
      {screenReader || !action ? (
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Dismiss" style={{ minWidth: action ? 48 : 64, minHeight: 48, alignItems: 'center', justifyContent: 'center' }}>
          {action ? <Icon name="x" color={textColor} size={18} strokeWidth={2.2} /> : <T v="bodyStrong" style={{ color: actionColor }}>OK</T>}
        </Pressable>
      ) : null}
    </View>
  );
}
