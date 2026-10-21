import { View } from 'react-native';
import { Card, Screen, T } from '@/components/ui';

/** Placeholder body for a tab whose build-plan item hasn't landed yet. */
export function StubScreen({ title, note, children }: { title: string; note: string; children?: React.ReactNode }) {
  return (
    <Screen title={title}>
      <Card><T v="body" tone="text2">{note}</T></Card>
      {children ? <View style={{ gap: 10 }}>{children}</View> : null}
    </Screen>
  );
}
