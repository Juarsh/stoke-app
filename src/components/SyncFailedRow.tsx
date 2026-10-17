// Today: an entry whose change could not be synced (Designer Oct 17). Under the row's meta, one line in the warn token at
// 13 px with the sync icon: "Couldn’t sync this. Tap to retry". The whole row is the tap target (≥ 44 px); while the
// retry is running the icon is a spinner and the row is busy. The entry's kcal is still counted on the phone.
import { ActivityIndicator, Pressable, View } from 'react-native';
import { makeStyles, useTheme } from '../theme';
import { Icon } from './Icon';
import { Row, T } from './ui';

export const SYNC_FAILED_COPY = 'Couldn’t sync this. Tap to retry';
export const SYNC_RETRYING_COPY = 'Retrying…';

export function SyncFailedRow({ title, kcal, retrying, onRetry }: { title: string; kcal?: number; retrying: boolean; onRetry: () => void }) {
  const t = useTheme(); const s = useStyles();
  return (
    <Pressable onPress={retrying ? undefined : onRetry} disabled={retrying} style={s.row} accessibilityRole="button"
      accessibilityState={{ busy: retrying, disabled: retrying }}
      accessibilityLabel={`${title}: ${retrying ? 'retrying sync' : 'couldn’t sync this. Tap to retry'}`}>
      <View style={{ flex: 1, gap: 2 }}>
        <Row style={{ gap: 10, justifyContent: 'space-between' }}>
          <T style={{ flex: 1 }} numberOfLines={1}>{title}</T>
          {kcal !== undefined ? <T v="caption" tone="muted">{Math.round(kcal).toLocaleString('en-IN')} kcal</T> : null}
        </Row>
        <Row style={{ gap: 6 }}>
          {retrying ? <ActivityIndicator testID="sync-retry-spinner" size={14} color={t.c.warn} /> : <Icon name="sync" color={t.c.warn} size={14} />}
          <T v="caption" tone="warn" style={s.line}>{retrying ? SYNC_RETRYING_COPY : SYNC_FAILED_COPY}</T>
        </Row>
      </View>
    </Pressable>
  );
}
const useStyles = makeStyles(() => ({
  row: { minHeight: 44, justifyContent: 'center', paddingVertical: 6 },
  line: { fontSize: 13, lineHeight: 18 },
}));
