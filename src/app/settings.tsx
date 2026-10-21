import { useRouter } from 'expo-router';
import { Alert, Switch } from 'react-native';
import { Button, Card, Field, Row, Screen, Segmented, T } from '@/components/ui';
import { config, flags } from '@/lib/config';
import { Diet } from '@/lib/domain';
import { connectSteps, readTodaySteps } from '@/lib/health';
import { useStore } from '@/lib/store';
import { useTheme } from '@/theme';

export default function Settings() {
  const st = useStore(); const router = useRouter(); const t = useTheme();
  const p = st.profile;
  if (!p) return null;
  const set = (patch: Partial<typeof p>) => st.setProfile({ ...p, ...patch });
  const sw = (v: boolean, on: (v: boolean) => void, label: string) => (
    <Row style={{ justifyContent: 'space-between', minHeight: 48 }}>
      <T style={{ flex: 1 }}>{label}</T>
      <Switch value={v} onValueChange={on} accessibilityLabel={label} trackColor={{ true: t.c.primary, false: t.c.surface3 }} thumbColor={t.c.surface} />
    </Row>
  );
  return (
    <Screen title="Settings" right={<Button kind="ghost" title="Done" onPress={() => router.back()} />}>
      <Card>
        <T v="bodyStrong">{st.user?.name}</T>
        <T v="caption" tone="muted">{st.user?.email} · {st.user?.mock ? 'mock sign-in' : 'Google'} · {config.mock ? 'offline/mock server' : 'synced'} · {st.queue.length} changes waiting to sync</T>
      </Card>
      <Card>
        <T v="bodyStrong">Targets</T>
        <Row>
          <Field label="Daily kcal" keyboardType="numeric" defaultValue={String(p.kcalTarget)} onEndEditing={(e) => set({ kcalTarget: Number(e.nativeEvent.text) || p.kcalTarget })} style={{ minWidth: 120 }} />
          <Field label="Protein g" keyboardType="numeric" defaultValue={String(p.proteinTarget)} onEndEditing={(e) => set({ proteinTarget: Number(e.nativeEvent.text) || p.proteinTarget })} style={{ minWidth: 120 }} />
        </Row>
        <T v="caption" tone="muted">Diet for coach picks</T>
        <Segmented value={p.diet} onChange={(diet: Diet) => set({ diet })} options={[{ value: 'veg', label: 'Veg' }, { value: 'egg', label: 'Egg + veg' }, { value: 'nonveg', label: 'Non-veg' }]} />
      </Card>
      <Card>
        <T v="bodyStrong">Appearance</T>
        <Segmented value={st.themePref} onChange={st.setThemePref} options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
      </Card>
      <Card>
        {flags.steps ? (
          <>
            <Row style={{ justifyContent: 'space-between', minHeight: 48 }}>
              <T style={{ flex: 1 }}>Health Connect steps</T>
              <Button kind="soft" title={flags.healthConnect ? 'Connect' : 'Off in this build'} disabled={!flags.healthConnect}
                onPress={async () => { const n = (await connectSteps()) ? await readTodaySteps() : null; Alert.alert('Health Connect', n === null ? 'Not available or permission denied.' : `Today: ${n} steps`); }} />
            </Row>
            {sw(p.addStepKcal, (v) => set({ addStepKcal: v }), 'Add step kcal to food budget')}
          </>
        ) : null}
        {sw(!p.showKcalOnCards, (v) => set({ showKcalOnCards: !v }), 'Hide calories on share cards')}
      </Card>
      <Button kind="soft" title={`Remembered foods · ${Object.keys(st.learned).length}`} onPress={() => router.push('/remembered')} />
      <Button kind="soft" title="Share today" onPress={() => router.push('/share')} />
      <Button kind="soft" title="Credits & licences" onPress={() => router.push('/credits')} />
      <Button kind="ghost" title="Sign out" onPress={() => { st.signOut(); }} />
      <Button kind="danger" title="Delete account & all data" onPress={() => Alert.alert('Delete everything?', 'This removes your account and all logs. It can’t be undone.', [
        { text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => st.deleteAll() }])} />
    </Screen>
  );
}
