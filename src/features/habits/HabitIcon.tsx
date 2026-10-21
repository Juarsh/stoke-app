// The Home habit item (§7.1): icon in a 36dp circle (outlined when not done; sage with the icon kept and a 16dp ringed ✓
// badge when done) and the short name under it, 15sp bold (19.5sp at 1.3×), breaking only at a space or hyphen, with the
// §8.4 runtime hyphen fallback for a word that still doesn't fit. Also used for the live previews in Create habit.
import { Text, useWindowDimensions, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { useTheme } from '@/theme';
import { fonts } from '@/theme/tokens';
import { HOME_SLOT_DP, hyphenate, monogram } from './model';

export const NAME_SP = 15;
export function HabitBadge({ icon, letter, done, size = 36 }: { icon: string | null; letter: string; done: boolean; size?: number }) {
  const t = useTheme();
  const fg = done ? (t.dark ? '#15121B' : '#FFFFFF') : t.c.text;
  return (
    <View style={{ width: size, height: size }}>
      <View style={{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center',
        backgroundColor: done ? t.c.train : 'transparent', borderWidth: done ? 0 : 2, borderColor: t.c.stateLine }}>
        {icon ? <Icon name={icon} color={fg} size={size * 0.5} strokeWidth={2} />
          : <Text allowFontScaling={false} style={{ fontFamily: fonts.dm[700], fontSize: size * 0.42, color: fg }}>{letter}</Text>}
      </View>
      {done ? (
        <View style={{ position: 'absolute', right: -5, top: -5, width: 16, height: 16, borderRadius: 8, backgroundColor: t.c.text, borderWidth: 1.5, borderColor: t.c.card,
          alignItems: 'center', justifyContent: 'center' }}>
          <Text allowFontScaling={false} style={{ color: t.c.card, fontSize: 9, lineHeight: 11, fontFamily: fonts.dm[700] }}>✓</Text>
        </View>
      ) : null}
    </View>
  );
}
/** item body; `scale` overrides the system font scale (Create habit's 1× / 1.3× previews) */
export function HabitItem({ short, name, icon, done, scale, twoLines }: { short: string; name: string; icon: string | null; done: boolean; scale?: number; twoLines?: boolean }) {
  const t = useTheme(); const { fontScale } = useWindowDimensions();
  const sp = NAME_SP * (scale ?? 1);
  const text = hyphenate(short || ' ', scale ? sp : NAME_SP * fontScale, HOME_SLOT_DP);
  return (
    <View style={{ width: HOME_SLOT_DP, alignItems: 'center', gap: 6 }}>
      <HabitBadge icon={icon} letter={monogram({ short_name: short, name })} done={done} />
      <Text allowFontScaling={scale === undefined} style={{ fontFamily: fonts.dm[700], fontSize: sp, lineHeight: sp * 1.25, textAlign: 'center', width: HOME_SLOT_DP,
        color: done ? t.c.muted : t.c.text, minHeight: twoLines ? sp * 2.5 : undefined }}>{text}</Text>
    </View>
  );
}
