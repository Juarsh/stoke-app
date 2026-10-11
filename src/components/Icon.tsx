import Svg, { Circle, Path } from 'react-native-svg';

const P: Record<string, string> = {
  today: 'M4 11l8-7 8 7v9H4z',
  log: 'M12 7v10M7 12h10',
  progress: 'M5 20V11M11 20V5M17 20v-6',
  coach: 'M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z',
  community: 'M9 11a3 3 0 100-6 3 3 0 000 6zM17 11a2.5 2.5 0 100-5M3 20c0-3 3-5 6-5s6 2 6 5M16 15c3 0 5 2 5 5',
  flame: 'M12 3c1 4 6 6 6 11a6 6 0 01-12 0c0-3 2-5 3-7 1 2 3 3 3 3s-1-4 0-7z',
  info: 'M12 8v.5M12 11v5', bowl: 'M4 11h16a8 8 0 01-16 0zM9 7c0-1 1-2 1-3M14 7c0-1 1-2 1-3', plate: 'M12 4a8 8 0 100 16 8 8 0 000-16zM12 8a4 4 0 100 8 4 4 0 000-8z',
  cup: 'M6 8h10v6a5 5 0 01-10 0zM16 10h2a2 2 0 010 4h-2', leaf: 'M5 19C5 10 11 5 19 5c0 8-5 14-14 14zM5 19l7-7', star: 'M12 4l2.4 5 5.6.8-4 3.9 1 5.5-5-2.7-5 2.7 1-5.5-4-3.9 5.6-.8z',
  drop: 'M12 4c3 4 6 7 6 10a6 6 0 01-12 0c0-3 3-6 6-10z', circle: 'M12 5a7 7 0 100 14 7 7 0 000-14z', back: 'M15 5l-7 7 7 7',
};
export function Icon({ name, color, size = 22 }: { name: string; color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      {name === 'info' || name === 'log' ? <Circle cx={12} cy={12} r={9} /> : null}
      <Path d={P[name] ?? P.circle} />
    </Svg>
  );
}
