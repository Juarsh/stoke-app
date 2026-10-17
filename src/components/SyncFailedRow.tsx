// Today: an entry whose change could not be synced (Designer Oct 17). Under the row's meta, one line in the warn token at
// 13 px with the sync icon: "Couldn’t sync this. Tap to retry". The whole row is the tap target (≥ 44 px); while the
// retry is running the icon is a spinner and the row is busy. The entry's kcal is still counted on the phone.
import { ActivityIndicator, Pressable, View } from 'react-native';
import { makeStyles, useTheme } from '../theme';
import { Icon } from './Icon';
import { Row, T } from './ui';
import { kc } from '../lib/format';

export const SYNC_FAILED_COPY = 'Couldn’t sync this. Tap to retry';
export const SYNC_RETRYING_COPY = 'Retrying…';

export function SyncFailedRow({ title, kcal, retrying, onRetry, reason, line, notCounted }: { title: string; kcal?: number;
  /** rg7 H1: the server never stored this row (5xx): it isn't counted, and the row says so */ notCounted?: boolean; retrying: boolean; onRetry: () => void; /** the server's reason, when it gave one */ reason?: string;
  /** replaces the retry line when the fix is a pick, not a retry (rg6 F4: "Pick a type to save this."; the tap opens the choices) */ line?: string }) {
  const t = useTheme(); const s = useStyles();
  const main = line ?? SYNC_FAILED_COPY;
  return (
    <Pressable onPress={retrying ? undefined : onRetry} disabled={retrying} style={s.row} accessibilityRole="button"
      accessibilityState={{ busy: retrying, disabled: retrying }}
      accessibilityLabel={`${title}: ${retrying ? 'retrying sync' : line ? line : `couldn’t sync this. Tap to retry${reason ? `. ${reason}` : ''}`}`}>
      <View style={{ flex: 1, gap: 2 }}>
        <Row style={{ gap: 10, justifyContent: 'space-between' }}>
          <T style={{ flex: 1 }} numberOfLines={1}>{title}</T>
          {notCounted ? <T v="caption" tone="muted">— kcal · not counted</T> : kcal !== undefined ? <T v="caption" tone="muted">{kc(kcal)} kcal</T> : null}
        </Row>
        <Row style={{ gap: 6 }}>
          {retrying ? <ActivityIndicator testID="sync-retry-spinner" size={14} color={t.c.warn} /> : <Icon name="sync" color={t.c.warn} size={14} />}
          <T v="caption" tone="warn" style={s.line}>{retrying ? SYNC_RETRYING_COPY : main}</T>
        </Row>
        {reason && !retrying && !line ? <T v="caption" tone="muted" testID="sync-reason">{reason}</T> : null}
      </View>
    </Pressable>
  );
}
const useStyles = makeStyles(() => ({
  row: { minHeight: 44, justifyContent: 'center', paddingVertical: 6 },
  line: { fontSize: 13, lineHeight: 18 },
}));
