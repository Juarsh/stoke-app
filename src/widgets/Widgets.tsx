// The four home-screen widgets (Android), drawn with react-native-android-widget primitives in the B2 tokens
// (src/theme/tokens: card surface + soft line, DM Sans, honey button, ink workout card), light and dark.
// Sizes: 2 cells wide, 1 or 2 high (resizable between them); `tall` switches the 2x2 layout.
import { FlexWidget, TextWidget } from 'react-native-android-widget';
import { palette, radius, type ColorTokens } from '../theme/tokens';
import { grams, kc } from '../lib/format';
import { ACTIONS, leftText, linkOf, ROUTES, type HabitsView, type TodayView, type WaterView, type WorkoutView } from './model';

type C = ColorTokens;
type Hex = `#${string}`;
const hex = (s: string) => s as Hex;
const BOLD = 'DMSans_700Bold', MED = 'DMSans_500Medium';
export interface Ctx { c: C; scheme: string; tall: boolean; note?: string | null }
const open = (x: Ctx, route: string) => ({ clickAction: 'OPEN_URI', clickActionData: { uri: linkOf(x.scheme, route) } });

function Card({ x, children, route, bg, line }: { x: Ctx; children: unknown; route?: string; bg?: string; line?: string }) {
  return (
    <FlexWidget {...(route ? open(x, route) : {})}
      style={{ height: 'match_parent', width: 'match_parent', flexDirection: 'column', justifyContent: 'space-between', padding: 12,
        backgroundColor: hex(bg ?? x.c.card), borderRadius: radius.card, borderWidth: 1, borderColor: hex(line ?? x.c.lineSoft) }}>
      {children as never}
    </FlexWidget>
  );
}
const Txt = ({ text, size, color, bold, lines = 1 }: { text: string; size: number; color: string; bold?: boolean; lines?: number }) => (
  <TextWidget text={text} maxLines={lines} truncate="END" style={{ fontSize: size, color: hex(color), fontFamily: bold ? BOLD : MED }} />
);
const Eyebrow = ({ x, text, color }: { x: Ctx; text: string; color?: string }) => <Txt text={text.toUpperCase()} size={11} color={color ?? x.c.muted} bold />;
/** honey pill (B2 primary button), 40dp high so it is easy to hit */
function Honey({ x, text, click }: { x: Ctx; text: string; click: Record<string, unknown> }) {
  return (
    <FlexWidget {...click} style={{ height: 40, width: 'match_parent', borderRadius: radius.button, backgroundColor: hex(x.c.accentFill), justifyContent: 'center', alignItems: 'center' }}>
      <Txt text={text} size={14} color={x.c.onAccent} bold />
    </FlexWidget>
  );
}
const Note = ({ x }: { x: Ctx }) => (x.note ? <Txt text={`⚠ ${x.note}`} size={11} color={x.c.warn} lines={2} /> : null);

export function TodayWidget({ x, v }: { x: Ctx; v: TodayView }) {
  const log = open(x, ROUTES.logFood);
  if (v.kind === 'setup') {
    return <Card x={x} route={ROUTES.home}><Eyebrow x={x} text="Today" /><Txt text="Set up Stoke to see your day" size={14} color={x.c.text} bold lines={2} /></Card>;
  }
  const kcalLine = `${kc(v.kcal)} / ${kc(v.kcalTarget)} kcal`;
  const protLine = `${grams(v.protein)} / ${grams(v.proteinTarget)} protein`;
  if (!x.tall) {
    return (
      <Card x={x} route={ROUTES.home}>
        <FlexWidget style={{ flexDirection: 'row', width: 'match_parent', alignItems: 'center', justifyContent: 'space-between' }}>
          <FlexWidget style={{ flexDirection: 'column', flex: 1 }}>
            <Txt text={kcalLine} size={15} color={x.c.text} bold />
            <Txt text={protLine} size={12} color={x.c.muted} />
          </FlexWidget>
          <FlexWidget {...log} style={{ height: 40, width: 56, marginLeft: 8, borderRadius: radius.button, backgroundColor: hex(x.c.accentFill), justifyContent: 'center', alignItems: 'center' }}>
            <Txt text="+ Log" size={13} color={x.c.onAccent} bold />
          </FlexWidget>
        </FlexWidget>
      </Card>
    );
  }
  return (
    <Card x={x} route={ROUTES.home}>
      <Eyebrow x={x} text="Today" />
      <FlexWidget style={{ flexDirection: 'column' }}>
        <Txt text={kc(v.kcal)} size={28} color={x.c.text} bold />
        <Txt text={`of ${kc(v.kcalTarget)} kcal · ${leftText(v.kcalLeft)}`} size={12} color={v.kcalLeft < 0 ? x.c.over : x.c.muted} />
        <Txt text={protLine} size={12} color={x.c.text2} />
      </FlexWidget>
      <Honey x={x} text="+ Log food" click={log} />
    </Card>
  );
}

export function HabitsWidget({ x, v }: { x: Ctx; v: HabitsView }) {
  if (!v.total) return <Card x={x} route={ROUTES.habits}><Eyebrow x={x} text="Habits" /><Txt text="No habits today. Tap to add one." size={13} color={x.c.text} lines={2} /></Card>;
  return (
    <Card x={x} route={ROUTES.habits}>
      <Eyebrow x={x} text={`Habits · ${v.done} of ${v.total}`} />
      <FlexWidget style={{ flexDirection: x.tall ? 'column' : 'row', width: 'match_parent', flexGap: 6 }}>
        {v.rows.map((r) => (
          <FlexWidget key={r.id} clickAction={ACTIONS.tickHabit} clickActionData={{ id: r.id }}
            style={{ height: 34, ...(x.tall ? { width: 'match_parent' } : { flex: 1 }), flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, borderRadius: radius.field,
              backgroundColor: hex(r.done ? x.c.sageFill : x.c.card2), borderWidth: 1, borderColor: hex(r.done ? x.c.sageFill : x.c.cardLine) }}>
            <Txt text={r.done ? '✓' : '○'} size={13} color={r.done ? x.c.onCheck : x.c.muted} bold />
            <FlexWidget style={{ flex: 1, marginLeft: 6 }}><Txt text={r.name} size={13} color={r.done ? x.c.onCheck : x.c.text} bold /></FlexWidget>
            {x.tall && r.streak > 1 ? <Txt text={`${r.streak}d`} size={11} color={r.done ? x.c.onCheck : x.c.muted} /> : null}
          </FlexWidget>
        ))}
      </FlexWidget>
      <Note x={x} />
    </Card>
  );
}

export function WaterWidget({ x, v }: { x: Ctx; v: WaterView }) {
  if (v.kind === 'none') {
    return <Card x={x} route={ROUTES.settings}><Eyebrow x={x} text="Water" /><Txt text="Track water: tap to set it up in Settings" size={13} color={x.c.text} lines={2} /></Card>;
  }
  const add = { clickAction: ACTIONS.addWater, clickActionData: {} };
  const count = `${v.count} / ${v.target}`;
  return (
    <Card x={x} route={ROUTES.habits}>
      <FlexWidget style={{ flexDirection: 'row', width: 'match_parent', alignItems: 'center', justifyContent: 'space-between' }}>
        <FlexWidget style={{ flexDirection: 'column', flex: 1 }}>
          <Eyebrow x={x} text={v.name} color={x.c.trainText} />
          <Txt text={count} size={x.tall ? 28 : 20} color={x.c.text} bold />
          <Txt text={v.done ? `${v.unit} · done` : v.unit} size={12} color={x.c.muted} />
        </FlexWidget>
        {x.tall ? null : (
          <FlexWidget {...add} style={{ height: 44, width: 56, marginLeft: 8, borderRadius: radius.button, backgroundColor: hex(x.c.accentFill), justifyContent: 'center', alignItems: 'center' }}>
            <Txt text="+1" size={16} color={x.c.onAccent} bold />
          </FlexWidget>
        )}
      </FlexWidget>
      {x.tall ? <Honey x={x} text="+ Add a glass" click={add} /> : null}
      <Note x={x} />
    </Card>
  );
}

export function WorkoutWidget({ x, v }: { x: Ctx; v: WorkoutView }) {
  // B2 "feat" workout card: ink surface + honey button
  const go = open(x, v.kind === 'none' ? ROUTES.choosePlan : v.kind === 'rest' ? ROUTES.startEmpty : ROUTES.startWorkout);
  return (
    <Card x={x} bg={x.c.ink} line={x.c.inkLine} route={ROUTES.train}>
      <FlexWidget style={{ flexDirection: 'column', width: 'match_parent' }}>
        {x.tall ? <Eyebrow x={x} text={v.kind === 'active' ? 'In progress' : 'Today'} color={x.c.inkMuted} /> : null}
        <Txt text={v.title} size={x.tall ? 20 : 15} color={x.c.inkText} bold />
        {x.tall ? <Txt text={v.sub} size={12} color={x.c.inkMuted} lines={2} /> : null}
      </FlexWidget>
      <FlexWidget {...go} style={{ height: x.tall ? 40 : 34, width: 'match_parent', borderRadius: radius.button, backgroundColor: hex(x.c.accentFill), justifyContent: 'center', alignItems: 'center' }}>
        <Txt text={`${v.kind === 'none' ? '' : '▶ '}${v.button}`} size={14} color={x.c.onAccent} bold />
      </FlexWidget>
    </Card>
  );
}

export const colorsFor = (dark: boolean) => (dark ? palette.dark : palette.light);
