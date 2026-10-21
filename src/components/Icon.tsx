import Svg, { Circle, Path } from 'react-native-svg';

const P: Record<string, string> = {
  today: 'M4 11l8-7 8 7v9H4z',
  warn: 'M12 4l9 16H3zM12 10v4M12 17v.5', trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3', chevron: 'M9 5l7 7-7 7',
  log: 'M12 7v10M7 12h10',
  progress: 'M5 20V11M11 20V5M17 20v-6',
  coach: 'M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z',
  community: 'M9 11a3 3 0 100-6 3 3 0 000 6zM17 11a2.5 2.5 0 100-5M3 20c0-3 3-5 6-5s6 2 6 5M16 15c3 0 5 2 5 5',
  flame: 'M12 3c1 4 6 6 6 11a6 6 0 01-12 0c0-3 2-5 3-7 1 2 3 3 3 3s-1-4 0-7z',
  info: 'M12 8v.5M12 11v5', bowl: 'M4 11h16a8 8 0 01-16 0zM9 7c0-1 1-2 1-3M14 7c0-1 1-2 1-3', plate: 'M12 4a8 8 0 100 16 8 8 0 000-16zM12 8a4 4 0 100 8 4 4 0 000-8z',
  cup: 'M6 8h10v6a5 5 0 01-10 0zM16 10h2a2 2 0 010 4h-2', leaf: 'M5 19C5 10 11 5 19 5c0 8-5 14-14 14zM5 19l7-7', star: 'M12 4l2.4 5 5.6.8-4 3.9 1 5.5-5-2.7-5 2.7 1-5.5-4-3.9 5.6-.8z',
  sync: 'M20 12a8 8 0 01-14.13 5.14M4 12a8 8 0 0114.13-5.14M14 7h4V3M10 17H6v4',
  // full-b2 nav + sheet glyphs (design/unified/full-b2/_defs.part)
  home: 'M4 11l8-7 8 7v9h-5v-6H9v6H4z', food: 'M3 11h18a9 9 0 0 1-18 0z M8 7c0-1.5 1-2 1-3.5M12 7c0-1.5 1-2 1-3.5',
  train: 'M3 10v4M6.5 7.5v9M17.5 7.5v9M21 10v4M6.5 12h11', prog: 'M4 20V11M10 20V5M16 20v-6M21 20H3', plus: 'M12 5v14M5 12h14',
  spark: 'M12 3l2.2 6.3L20.5 11.5l-6.3 2.2L12 20l-2.2-6.3L3.5 11.5l6.3-2.2z',
  search: 'M10.5 4a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM15.5 15.5L20 20', pencil: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  minus: 'M5 12h14', down: 'M7 10l5 5 5-5', chev: 'M9 6l6 6-6 6', x: 'M6 6l12 12M18 6L6 18',
  habit: 'M12 3a9 9 0 100 18 9 9 0 000-18zM8 12.5l2.7 2.7L16 9.8',
  moon: 'M19 14.5A7.5 7.5 0 019.5 5a7.5 7.5 0 109.5 9.5z', play: 'M8 5.5l10 6.5-10 6.5z', up: 'M7 14l5-5 5 5',
  drop: 'M12 4c3 4 6 7 6 10a6 6 0 01-12 0c0-3 3-6 6-10z', circle: 'M12 5a7 7 0 100 14 7 7 0 000-14z', back: 'M15 5l-7 7 7 7',
};
const FILLED = new Set(['spark', 'play']);
export function Icon({ name, color, size = 22, strokeWidth = 1.8 }: { name: string; color: string; size?: number; strokeWidth?: number }) {
  const filled = FILLED.has(name);
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? color : 'none'} stroke={filled ? 'none' : color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      {name === 'info' || name === 'log' ? <Circle cx={12} cy={12} r={9} /> : null}
      <Path d={P[name] ?? P.circle} />
    </Svg>
  );
}
