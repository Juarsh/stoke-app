// Widget data → JSX, light and dark. With the app's theme on System the launcher picks by the system setting; a theme
// picked in Settings (Light / Dark) is used for the widgets too.
import type { WidgetInfo, WidgetRepresentation } from 'react-native-android-widget';
import { brand } from '../lib/config';
import type { WidgetData } from './actions';
import { habitsView, isTall, todayView, waterView, workoutView, WIDGETS } from './model';
import { colorsFor, HabitsWidget, TodayWidget, WaterWidget, WorkoutWidget, type Ctx } from './Widgets';

export function widgetFor(name: string, d: WidgetData, info: Pick<WidgetInfo, 'height'>, note?: string | null): WidgetRepresentation | null {
  const tall = isTall(info.height);
  const one = (dark: boolean) => {
    const x: Ctx = { c: colorsFor(dark), scheme: brand.scheme, tall, note };
    switch (name) {
      case WIDGETS.today: return <TodayWidget x={x} v={todayView(d.app, d.date)} />;
      case WIDGETS.habits: return <HabitsWidget x={x} v={habitsView(d.habits, d.date, tall ? 4 : 2)} />;
      case WIDGETS.water: return <WaterWidget x={x} v={waterView(d.habits, d.date)} />;
      case WIDGETS.workout: return <WorkoutWidget x={x} v={workoutView(d.plans, d.workouts, d.date)} />;
      default: return null;
    }
  };
  const light = one(false), dark = one(true);
  if (!light || !dark) return null;
  if (d.app.themePref === 'light') return light;
  if (d.app.themePref === 'dark') return dark;
  return { light, dark };
}
