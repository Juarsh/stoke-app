// Rest timer C (build-plan item 11, spec §11; rest-timer/active-logger-timer-c[-expanded|-done]): a pill floating above the
// bottom edge with a small ring, "1:12 · Set 2 · 60 kg × 10", the alert line and Skip (64×48). Tapping the pill (outside
// Skip) expands it in place to "1:12 of 1:30 · Next: …", ⋯ (vibrate on/off), −15s · +15s · Skip rest (52dp) and ⌄; it
// collapses after 8 s with no touch (every touch restarts the 8 s). At 0:00 the phone vibrates once (when on) and the pill
// reads "Rest done · Set 2 · …" with the ring full; Skip becomes +15s; it fades after 8 s with no touch or when the next set
// is ticked (which starts the next rest). Card surface, honey only for the ring and Skip.
// Tester B1: the end is the stored ends_at (never a tick count). Outside the app a local notification fires at that time
// (src/lib/restAlert). Coming back to the app (AppState) or to the logger after the end shows "Rest done" and the next
// set's outline as if it had just ended; the 8 s fade counts from that moment, and there is no late vibration (> LATE_MS).
// Tester O2: no live region on the ticking text; TalkBack hears the start, "10 seconds left" and "Rest done" once each.
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, AppState, Pressable, Vibration, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { T } from '@/components/ui';
import type { ExerciseRepo } from '@/lib/exercises';
import { useWorkouts } from '@/lib/workouts';
import { useTheme } from '@/theme';
import { setRestTimerVisible } from '@/lib/restAlert';
import { mmss, restLeft, restNextLabel, spoken } from './model';

export const IDLE_MS = 8000;
/** a rest that ended longer ago than this (app in the background, logger off screen) shows "Rest done" without vibrating */
export const LATE_MS = 5000;
export const WARN_S = 10;
const isActive = (st: string | null | undefined) => st !== 'background' && st !== 'inactive';
const announce = (msg: string) => { try { AccessibilityInfo.announceForAccessibility(msg); } catch { /* no screen reader API */ } };
/** the alert line: only vibration exists in this build (a chime needs a native audio module; see the item 11 notes) */
export const alertLine = (vibrate: boolean) => (vibrate ? 'Vibrate on' : 'Vibrate off');

function Ring({ frac, size, color, track }: { frac: number; size: number; color: string; track: string }) {
  const r = (size - 8) / 2, c = 2 * Math.PI * r;
  return (
    <Svg width={size} height={size}>
      <Circle cx={size / 2} cy={size / 2} r={r} stroke={track} strokeWidth={6} fill="none" />
      <Circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={6} fill="none" strokeLinecap="round"
        strokeDasharray={`${c} ${c}`} strokeDashoffset={c * (1 - Math.max(0, Math.min(1, frac)))} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
    </Svg>
  );
}

export function RestTimer({ now, repo }: { now: number; repo: ExerciseRepo }) {
  const t = useTheme(); const ins = useSafeAreaInsets(); const w = useWorkouts();
  const a = w.active; const rest = a?.rest ?? null;
  const [open, setOpen] = useState(false);
  const [touched, setTouched] = useState(now);
  const nowRef = useRef(now); nowRef.current = now;
  const alerted = useRef<number | null>(null);
  const [appOn, setAppOn] = useState(isActive(AppState.currentState));
  // when the rest end was first seen with the app open (the 8 s "Rest done" fade counts from here, not from ends_at)
  const [seen, setSeen] = useState<{ end: number; at: number } | null>(null);
  const resumed = useRef(0); // the moment the app came back (the `now` prop can still be the frozen pre-background tick)
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => { const on = isActive(st); setAppOn(on); if (on) { resumed.current = Date.now(); setSeen(null); } });
    return () => sub.remove();
  }, []);
  const left = rest ? restLeft(rest, now) : 0;
  const done = !!rest && left === 0;
  const visible = !!rest && appOn;
  useEffect(() => { setRestTimerVisible(visible); return () => setRestTimerVisible(false); }, [visible]);
  const label = rest && a ? restNextLabel(a, rest, w.previous, repo) : null;
  useEffect(() => {
    if (!rest || !done || !appOn || seen?.end === rest.ends_at) return;
    const t = Math.max(nowRef.current, resumed.current);
    setSeen({ end: rest.ends_at, at: t });
    if (alerted.current === rest.ends_at) return;
    alerted.current = rest.ends_at;
    if (w.state.prefs.vibrate && t - rest.ends_at <= LATE_MS) Vibration.vibrate([0, 300, 150, 300]);
    announce(`Rest done${label ? `. Next: ${label}` : ''}`);
  }, [done, rest, appOn, seen, label, w.state.prefs.vibrate]);
  // TalkBack: once when a rest starts (within 2 s of its start, so a remount mid-rest stays quiet) and once at 10 s left
  const started = useRef<string | null>(null), warned = useRef<number | null>(null);
  useEffect(() => {
    if (!rest || done || !appOn) return;
    const key = `${rest.ex_id}|${rest.set_id}`;
    if (started.current !== key) { started.current = key; if (rest.total_s - left <= 2) announce(`Rest started, ${spoken(Math.min(left, rest.total_s))}${label ? `. Next: ${label}` : ''}`); }
    if (rest.total_s > WARN_S && left <= WARN_S && warned.current !== rest.ends_at) { warned.current = rest.ends_at; announce(`${spoken(left)} left`); }
  }, [rest, done, appOn, left, label]);
  // the 8 s idle clock starts at the last touch, the rest's start, or the moment "Rest done" was first seen, whichever is latest
  const doneAt = rest && seen?.end === rest.ends_at ? seen.at : null;
  const since = rest ? Math.max(touched, done ? (doneAt ?? Infinity) : rest.ends_at - rest.total_s * 1000) : touched;
  useEffect(() => {
    if (!rest || !appOn || now - since < IDLE_MS) return;
    if (done) w.endRest(); else if (open) setOpen(false);
  }, [now, since, rest, done, open, appOn, w]);
  if (!a || !rest) return null;
  const touch = () => setTouched(nowRef.current);
  const next = label;
  const ringColor = t.dark ? t.c.accentFill : t.c.honeyEdge;
  const frac = done ? 1 : rest.total_s ? left / rest.total_s : 0;
  const line = alertLine(w.state.prefs.vibrate);
  const shell = { position: 'absolute', left: 16, right: 16, bottom: 16 + ins.bottom, backgroundColor: t.c.card, borderRadius: 26, borderWidth: 1, borderColor: t.c.lineSoft, ...t.elev.e3 } as const;
  const btn = (title: string, onPress: () => void, honey?: boolean, flex = 1) => (
    <Pressable onPress={() => { touch(); onPress(); }} accessibilityRole="button" accessibilityLabel={title}
      style={({ pressed }) => ({ flex, minHeight: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: honey ? t.c.accentFill : t.c.card2,
        borderWidth: 1.5, borderColor: honey ? t.c.honeyEdge : t.c.cardLine, opacity: pressed ? 0.85 : 1 })}>
      <T v="bodyStrong" style={{ fontSize: 17, color: honey ? t.c.onAccent : t.c.text }}>{title}</T>
    </Pressable>
  );
  if (open) {
    return (
      <View style={[shell, { padding: 16, gap: 10 }]} testID="rest-expanded" onTouchStart={touch}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <Ring frac={frac} size={64} color={ringColor} track={t.c.track} />
          <View style={{ flex: 1 }} accessible accessibilityRole="timer" accessibilityLabel={done ? `Rest done. ${next ?? ''}` : `Rest, ${spoken(left)} left of ${spoken(rest.total_s)}. Next: ${next ?? 'none'}`}>
            <T style={{ fontSize: 15 }}><T v="display" style={{ fontSize: 34, lineHeight: 40 }}>{done ? 'Rest done' : mmss(left)}</T>{done ? '' : `  of ${mmss(rest.total_s)}`}</T>
            {next ? <T tone="text2" style={{ fontSize: 14 }}>{`Next: ${next}`}</T> : null}
          </View>
          <Pressable onPress={() => setOpen(false)} accessibilityRole="button" accessibilityLabel="Collapse rest timer" style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="down" color={t.c.text} size={22} strokeWidth={2.2} />
          </Pressable>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <T tone="text2" style={{ flex: 1, fontSize: 14 }}>{line}</T>
          <Pressable onPress={() => { touch(); w.setVibrate(!w.state.prefs.vibrate); }} accessibilityRole="switch" accessibilityState={{ checked: w.state.prefs.vibrate }}
            accessibilityLabel="Vibrate when rest ends" style={{ minHeight: 48, paddingHorizontal: 8, justifyContent: 'center' }}>
            <T v="bodyStrong" style={{ color: t.c.accentText, fontSize: 14 }}>{w.state.prefs.vibrate ? 'Turn vibrate off' : 'Turn vibrate on'}</T>
          </Pressable>
        </View>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          {btn('−15s', () => w.shiftRest(-15))}{btn('+15s', () => w.shiftRest(15))}{btn(done ? 'Dismiss' : 'Skip rest', () => w.endRest(), true, 1.6)}
        </View>
      </View>
    );
  }
  return (
    <View style={[shell, { flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 12, paddingRight: 10, paddingVertical: 10 }]} testID="rest-pill">
      <Pressable onPress={() => { touch(); setOpen(true); }} accessibilityRole="button"
        accessibilityLabel={`${done ? 'Rest done' : `Rest, ${spoken(left)} left`}${next ? `, ${next}` : ''}. ${line}. Open rest timer`}
        style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 }}>
        <Ring frac={frac} size={48} color={ringColor} track={t.c.track} />
        <View style={{ flex: 1 }}>
          <T style={{ fontSize: 15 }}><T v="bodyStrong" style={{ fontSize: 20 }}>{done ? 'Rest done' : mmss(left)}</T>{next ? ` · ${next}` : ''}</T>
          <T tone="text2" style={{ fontSize: 13 }}>{line}</T>
        </View>
      </Pressable>
      <Pressable onPress={() => { touch(); if (done) w.shiftRest(15); else w.endRest(); }} accessibilityRole="button" accessibilityLabel={done ? 'Add 15 seconds' : 'Skip rest'}
        style={({ pressed }) => ({ width: 64, height: 48, borderRadius: 24, backgroundColor: t.c.accentFill, borderWidth: 1.5, borderColor: t.c.honeyEdge, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.85 : 1 })}>
        <T v="bodyStrong" style={{ fontSize: 16, color: t.c.onAccent }}>{done ? '+15s' : 'Skip'}</T>
      </Pressable>
    </View>
  );
}
