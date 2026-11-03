// The widget task handler (headless JS, registered in index.ts): draws a widget when it is added, resized or due for its
// update, and runs the two background taps (tick a habit, add a glass) through ./actions, then redraws. A refused tap
// shows its reason on the widget (nothing was written).
import type { WidgetTaskHandlerProps } from 'react-native-android-widget';
import { addWater, loadWidgetData, tickHabit } from './actions';
import { ACTIONS, WIDGETS } from './model';
import { refreshWidgets } from './refresh';
import { widgetFor } from './render';

export async function widgetTaskHandler(props: WidgetTaskHandlerProps): Promise<void> {
  const { widgetInfo, widgetAction, clickAction, clickActionData } = props;
  if (widgetAction === 'WIDGET_DELETED') return;
  let note: string | null = null;
  if (widgetAction === 'WIDGET_CLICK') {
    if (clickAction === ACTIONS.tickHabit && typeof clickActionData?.id === 'string') note = await tickHabit(clickActionData.id);
    else if (clickAction === ACTIONS.addWater) note = await addWater();
  }
  const d = await loadWidgetData();
  const w = widgetFor(widgetInfo.widgetName, d, widgetInfo, note);
  if (w) props.renderWidget(w);
  // a habit tick shows on the Water widget too (and the reverse): redraw the other habits widget
  if (widgetAction === 'WIDGET_CLICK' && !note) {
    const other = widgetInfo.widgetName === WIDGETS.water ? WIDGETS.habits : widgetInfo.widgetName === WIDGETS.habits ? WIDGETS.water : null;
    if (other) await refreshWidgets([other], d);
  }
}
