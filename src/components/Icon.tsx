import Svg, { Circle, Path } from 'react-native-svg';

const P: Record<string, string> = {
  today: 'M4 11l8-7 8 7v9H4z',
  log: 'M12 5v14M5 12h14',
  progress: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  coach: 'M4 5h16v11H9l-5 4z',
  community: 'M8 11a3 3 0 100-6 3 3 0 000 6zM16 11a3 3 0 100-6 3 3 0 000 6zM2 20c0-3 3-5 6-5s6 2 6 5M14 15c3 0 8 1 8 5',
  flame: 'M12 3c1 4 6 6 6 11a6 6 0 01-12 0c0-3 2-5 3-7 1 2 3 3 3 3s-1-4 0-7z',
  info: 'M12 8v.5M12 11v5',
  back: 'M15 5l-7 7 7 7',
};
export function Icon({ name, color, size = 22 }: { name: keyof typeof P | string; color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      {name === 'info' ? <Circle cx={12} cy={12} r={9} /> : null}
      <Path d={P[name] ?? ''} />
    </Svg>
  );
}
