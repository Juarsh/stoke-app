// Settings → Targets (bug fix Oct 21, owner on iPhone/Expo Go: "can't update the daily calorie target").
// Was: uncontrolled defaultValue + onEndEditing(Number(e.nativeEvent.text) || old). On iOS the number pad has no return key
// and nativeEvent.text can be undefined, so the edit was silently dropped. Now: controlled text in local state, an explicit
// Save (enabled only when a value changed and both are valid), a Done bar above the iOS number pad, and the refusal reason
// inline in the warn colour. Nothing is clamped or silently replaced by the old value.
import { useState } from 'react';
import { InputAccessoryView, Keyboard, Platform, Pressable, View } from 'react-native';
import { Button, Card, Field, Row, T } from '@/components/ui';
import { Profile, TargetField, targetError, targetNumber } from '@/lib/domain';
import { useTheme } from '@/theme';

export const TARGETS_DONE_ID = 'targets-done';

function TargetInput({ k, label, unit, stored, draft, onChange, error }: { k: TargetField; label: string; unit: string; stored: number; draft: string | null; onChange: (v: string) => void; error: string | null }) {
  const t = useTheme();
  const shown = draft !== null && error;
  return (
    <View style={{ flex: 1, minWidth: 120, gap: 4 }}>
      <Field label={`${label} (${unit})`} accessibilityLabel={label} accessibilityHint={shown ? error : undefined} keyboardType="number-pad" returnKeyType="done"
        inputAccessoryViewID={Platform.OS === 'ios' ? TARGETS_DONE_ID : undefined} value={draft ?? String(stored)} maxLength={6}
        onChangeText={onChange} onSubmitEditing={() => Keyboard.dismiss()} testID={`target-${k}`}
        style={[{ minHeight: 48 }, shown ? { borderColor: t.c.warn, borderWidth: 1.5 } : null]} />
      {shown ? <T v="caption" tone="warn" accessibilityLiveRegion="polite">⚠ {error}</T> : null}
    </View>
  );
}

export function TargetsCard({ profile: p, onSave, children }: { profile: Profile; onSave: (patch: Pick<Profile, 'kcalTarget' | 'proteinTarget'>) => void; children?: React.ReactNode }) {
  const t = useTheme();
  // null = showing the saved value, so a change from elsewhere (server row, onboarding) shows up here too
  const [kcal, setKcal] = useState<string | null>(null);
  const [prot, setProt] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const kcalText = kcal ?? String(p.kcalTarget); const protText = prot ?? String(p.proteinTarget);
  const kErr = targetError('kcalTarget', kcalText, p.maintenanceKcal); const pErr = targetError('proteinTarget', protText);
  const kN = targetNumber(kcalText); const pN = targetNumber(protText);
  const changed = (kN !== null && kN !== p.kcalTarget) || (pN !== null && pN !== p.proteinTarget) || (kcal !== null && kN === null) || (prot !== null && pN === null);
  const canSave = changed && !kErr && !pErr;
  const save = () => {
    if (!canSave || kN === null || pN === null) return;
    onSave({ kcalTarget: kN, proteinTarget: pN });
    setKcal(null); setProt(null); setSaved(true); Keyboard.dismiss();
  };
  const edit = (set: (v: string) => void) => (v: string) => { set(v); setSaved(false); };
  return (
    <Card>
      {/* tap outside the inputs to close the keyboard; accessible={false} keeps it out of the screen-reader order */}
      <Pressable onPress={() => Keyboard.dismiss()} accessible={false} style={{ gap: 8 }}>
        <T v="bodyStrong">Targets</T>
        <Row style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <TargetInput k="kcalTarget" label="Daily kcal" unit="kcal" stored={p.kcalTarget} draft={kcal} onChange={edit(setKcal)} error={kErr} />
          <TargetInput k="proteinTarget" label="Protein" unit="g" stored={p.proteinTarget} draft={prot} onChange={edit(setProt)} error={pErr} />
        </Row>
        <Button title="Save targets" accessibilityLabel="Save targets" disabled={!canSave} onPress={save} style={{ minHeight: 48 }} />
        {saved ? <T v="caption" tone="muted" accessibilityLiveRegion="polite">{`Saved. Home uses ${p.kcalTarget.toLocaleString('en-IN')} kcal and ${p.proteinTarget} g protein.`}</T> : null}
        {children}
      </Pressable>
      {Platform.OS === 'ios' ? (
        <InputAccessoryView nativeID={TARGETS_DONE_ID}>
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', backgroundColor: t.c.card2, borderTopWidth: 1, borderTopColor: t.c.cardLine }}>
            <Pressable onPress={() => Keyboard.dismiss()} accessibilityRole="button" accessibilityLabel="Done" style={{ minHeight: 48, minWidth: 64, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' }}>
              <T v="bodyStrong" tone="em">Done</T>
            </Pressable>
          </View>
        </InputAccessoryView>
      ) : null}
    </Card>
  );
}
