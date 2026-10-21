// Shared bits of the workout summary and session detail: the ink stats card (Duration · Total volume · Sets · Reps).
import { View } from 'react-native';
import { T } from '@/components/ui';
import type { ExerciseRepo } from '@/lib/exercises';
import { useTheme } from '@/theme';
import { dayLabel, durationMin, fmtVolume, timeRange } from './history';
import { Session, stats } from './model';

const n = (x: number) => Math.round(x).toLocaleString('en-US');

export function InkStats({ s, repo, eyebrow }: { s: Session; repo: ExerciseRepo; eyebrow: 'title' | 'date' }) {
  const t = useTheme(); const st = stats(s, repo);
  const left = eyebrow === 'title' ? s.title : dayLabel(s.local_date);
  const right = eyebrow === 'title' ? `${dayLabel(s.local_date)} · ${timeRange(s)}` : timeRange(s);
  const cell = (label: string, value: string) => (
    <View style={{ flex: 1, gap: 2 }} accessible accessibilityLabel={`${label}: ${value}`}>
      <T style={{ color: t.c.inkMuted, fontSize: 15 }}>{label}</T>
      <T v="display" style={{ color: t.c.inkText, fontSize: 28, lineHeight: 34 }}>{value}</T>
    </View>
  );
  return (
    <View style={{ backgroundColor: t.c.ink, borderRadius: t.radius.card, padding: 20, gap: 14 }} testID="ink-stats">
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', columnGap: 8 }}>
        <T v="eyebrow" style={{ color: t.c.inkText, fontSize: 13, letterSpacing: 1, textTransform: 'uppercase' }}>{left}</T>
        <T style={{ color: t.c.inkMuted, fontSize: 14 }}>{right}</T>
      </View>
      <View style={{ flexDirection: 'row', gap: 12 }}>{cell('Duration', `${durationMin(s)} min`)}{cell('Total volume', fmtVolume(st.volume))}</View>
      <View style={{ flexDirection: 'row', gap: 12 }}>{cell('Sets', n(st.done))}{cell('Reps', n(st.reps))}</View>
    </View>
  );
}
