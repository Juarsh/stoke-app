// Rest timer C (build-plan item 11, spec §11; rest-timer/active-logger-timer-c[-expanded|-done]): a pill floating above the
// bottom edge with a small ring, "1:12 · Set 2 · 60 kg × 10", the alert line and Skip (64×48). Tapping the pill (outside
// Skip) expands it in place to "1:12 of 1:30 · Next: …", ⋯ (vibrate on/off), −15s · +15s · Skip rest (52dp) and ⌄; it
// collapses after 8 s with no touch (every touch restarts the 8 s). At 0:00 the phone vibrates once (when on) and the pill
// reads "Rest done · Set 2 · …" with the ring full; Skip becomes +15s; it fades after 8 s with no touch or when the next set
// is ticked (which starts the next rest). Card surface, honey only for the ring and Skip.
import { useEffect, useRef, useState } from 'react';
import { Pressable, Vibration, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { T } from '@/components/ui';
import type { ExerciseRepo } from '@/lib/exercises';
import { useWorkouts } from '@/lib/workouts';
import { useTheme } from '@/theme';
import { mmss, restLeft, restNextLabel } from './model';

export const IDLE_MS = 8000;
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
  const left = rest ? restLeft(rest, now) : 0;
  const done = !!rest && left === 0;
  useEffect(() => {
    if (!rest || !done || alerted.current === rest.ends_at) return;
    alerted.current = rest.ends_at;
    if (w.state.prefs.vibrate) Vibration.vibrate([0, 300, 150, 300]);
  }, [done, rest, w.state.prefs.vibrate]);
  // the 8 s idle clock starts at the last touch, the rest's start, or the moment it reached 0:00, whichever is latest
  const since = rest ? Math.max(touched, done ? rest.ends_at : rest.ends_at - rest.total_s * 1000) : touched;
  useEffect(() => {
    if (!rest || now - since < IDLE_MS) return;
    if (done) w.endRest(); else if (open) setOpen(false);
  }, [now, since, rest, done, open, w]);
  if (!a || !rest) return null;
  const touch = () => setTouched(nowRef.current);
  const next = restNextLabel(a, rest, w.previous, repo);
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
          <View style={{ flex: 1 }} accessible accessibilityLiveRegion="polite" accessibilityLabel={done ? `Rest done. ${next ?? ''}` : `Rest ${mmss(left)} of ${mmss(rest.total_s)}. Next: ${next ?? 'none'}`}>
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
      <Pressable onPress={() => { touch(); setOpen(true); }} accessibilityRole="button" accessibilityLiveRegion="polite"
        accessibilityLabel={`${done ? 'Rest done' : `Rest ${mmss(left)}`}${next ? `, ${next}` : ''}. ${line}. Open rest timer`}
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
