// Today: a counted row that carries a note from the server (rg6 F1 "Saved as …", rg10 "Not deleted: the server kept this
// entry. …"). Designer Oct 17: laid out like the other plate rows: the title left, its COUNTED kcal right (the number the
// totals add); the note on its own line underneath in the warn token at 13 px; "OK" at the end of that line is a real
// ≥ 44 × 44 tap target that dismisses the note. Copy comes from the caller unchanged.
import { Pressable, View } from 'react-native';
import { makeStyles } from '../theme';
import { Row, T } from './ui';
import { kc } from '../lib/format';

export const NOTE_OK_COPY = 'OK';
export function ServerNoteRow({ title, kcal, note, onDismiss }: { title: string; /** undefined: not known (shows '— kcal') */ kcal?: number; note: string; onDismiss: () => void }) {
  const s = useStyles();
  return (
    <View style={s.row} testID="server-note-row">
      <Row style={{ gap: 10, justifyContent: 'space-between' }}>
        <T style={{ flex: 1 }} numberOfLines={1}>{title}</T>
        <T v="caption" tone="muted" testID="server-note-kcal">{kcal === undefined ? '— kcal' : `${kc(kcal)} kcal`}</T>
      </Row>
      <Row style={{ gap: 6, alignItems: 'center' }}>
        <T v="caption" tone="warn" style={s.line} testID="server-note">{note}</T>
        <Pressable onPress={onDismiss} style={s.ok} accessibilityRole="button" testID="server-note-ok"
          accessibilityLabel={`Dismiss note on ${title}: ${note}`}>
          <T v="label" tone="em">{NOTE_OK_COPY}</T>
        </Pressable>
      </Row>
    </View>
  );
}
const useStyles = makeStyles(() => ({
  row: { minHeight: 44, justifyContent: 'center', paddingTop: 6, gap: 0 },
  line: { flex: 1, fontSize: 13, lineHeight: 18 },
  ok: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', marginRight: -8 },
}));
