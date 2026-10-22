import { useRouter } from 'expo-router';
import { Alert, KeyboardAvoidingView, Platform, Switch } from 'react-native';
import { Button, Card, Row, Screen, Segmented, T } from '@/components/ui';
import { TargetsCard } from '@/features/settings/TargetsCard';
import { GoogleSignIn } from '@/features/account/GoogleSignIn';
import { config, flags } from '@/lib/config';
import { Diet } from '@/lib/domain';
import { connectSteps, healthEnabled, healthName, readTodaySteps } from '@/lib/health';
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
    // iOS: keep the target inputs above the number pad (Screen's ScrollView already has keyboardShouldPersistTaps="handled")
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <Screen title="Settings" right={<Button kind="ghost" title="Done" onPress={() => router.back()} />}>
      {flags.googleSignIn ? (
        <Card>
          {st.signedInGoogle ? (
            <>
              <T v="bodyStrong">{st.user?.name}</T>
              <T accessibilityLabel={`Signed in as ${st.user?.email}`}>{`Signed in as ${st.user?.email}`}</T>
              <T v="caption" tone="muted">{st.queue.length ? `${st.queue.length} changes waiting to sync` : 'Synced'}</T>
              <Button kind="soft" title="Sign out" onPress={() => Alert.alert('Sign out?', 'Everything stays on this phone. Sign in again to sync it.', [
                { text: 'Cancel', style: 'cancel' }, { text: 'Sign out', onPress: () => st.signOut() }])} />
            </>
          ) : (
            <>
              <T v="bodyStrong">On this phone only</T>
              <T v="caption" tone="muted">{`Not signed in. Sign in to back up and sync; what’s on this phone goes up then.${st.queue.length ? ` ${st.queue.length} changes waiting.` : ''}`}</T>
              <GoogleSignIn />
            </>
          )}
        </Card>
      ) : (
        <Card>
          <T v="bodyStrong">{st.user?.name}</T>
          <T v="caption" tone="muted">{st.user?.email} · {st.user?.mock ? 'mock sign-in' : 'Google'} · {config.mock ? 'offline/mock server' : 'synced'} · {st.queue.length} changes waiting to sync</T>
        </Card>
      )}
      <TargetsCard profile={p} onSave={(patch) => set(patch)}>
        <T v="caption" tone="muted">Diet for coach picks</T>
        <Segmented value={p.diet} onChange={(diet: Diet) => set({ diet })} options={[{ value: 'veg', label: 'Veg' }, { value: 'egg', label: 'Egg + veg' }, { value: 'nonveg', label: 'Non-veg' }]} />
      </TargetsCard>
      <Card>
        <T v="bodyStrong">Appearance</T>
        <Segmented value={st.themePref} onChange={st.setThemePref} options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
      </Card>
      <Card>
        {flags.steps ? (
          <>
            <Row style={{ justifyContent: 'space-between', minHeight: 48 }}>
              <T style={{ flex: 1 }}>{`${healthName()} steps`}</T>
              <Button kind="soft" title={healthEnabled() ? 'Connect' : 'Off in this build'} disabled={!healthEnabled()}
                onPress={async () => { const n = (await connectSteps()) ? await readTodaySteps() : null; Alert.alert(healthName(), n === null ? 'Not available or permission denied.' : `Today: ${n} steps`); }} />
            </Row>
            {sw(p.addStepKcal, (v) => set({ addStepKcal: v }), 'Add step kcal to food budget')}
          </>
        ) : null}
        {sw(!p.showKcalOnCards, (v) => set({ showKcalOnCards: !v }), 'Hide calories on share cards')}
      </Card>
      <Button kind="soft" title={`Remembered foods · ${Object.keys(st.learned).length}`} onPress={() => router.push('/remembered')} />
      <Button kind="soft" title="Share today" onPress={() => router.push('/share')} />
      <Button kind="soft" title="Credits & licences" onPress={() => router.push('/credits')} />
      {flags.googleSignIn ? null : <Button kind="ghost" title="Sign out" onPress={() => { st.signOut(); }} />}
      <Button kind="danger" title="Delete account & all data" onPress={() => Alert.alert('Delete everything?', 'This removes your account and all logs. It can’t be undone.', [
        { text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => st.deleteAll() }])} />
    </Screen>
    </KeyboardAvoidingView>
  );
}
