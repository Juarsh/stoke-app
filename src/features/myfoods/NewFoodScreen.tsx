// §6.4 "+ New food": the form on its own screen. "Save food" saves to My foods only (never the tray).
import { useRouter } from 'expo-router';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { T } from '@/components/ui';
import { useStore } from '@/lib/store';
import { useTheme } from '@/theme';
import { FoodForm } from './FoodForm';
import { newDraft } from './model';
import { useFoodDraft } from './useFoodDraft';
import { SaveButton } from './SaveButton';

export function NewFoodScreen() {
  const t = useTheme(); const ins = useSafeAreaInsets(); const router = useRouter(); const st = useStore();
  const f = useFoodDraft(newDraft(), st.myFoods);
  const save = () => { const food = f.trySave(st.newId()); if (food) { st.saveMyFood(food); router.back(); } };
  const name = f.draft.name.trim().toLowerCase() || 'this food';
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.c.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={{ paddingTop: ins.top + 6, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', minHeight: 56 + ins.top }}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" style={{ width: 48, height: 48, marginLeft: -14, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="back" color={t.c.text} size={22} strokeWidth={2.2} />
        </Pressable>
        <T v="title" accessibilityRole="header" style={{ fontSize: 22, flex: 1 }}>New food</T>
      </View>
      <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 10 }} keyboardShouldPersistTaps="handled">
        <FoodForm draft={f.draft} onChange={f.setDraft} errors={f.errors} clash={f.clash} focus={f.focus} onFocused={f.onFocused} />
      </ScrollView>
      <View style={{ paddingHorizontal: 20, paddingTop: 4, paddingBottom: 16 + ins.bottom }}>
        <SaveButton title="Save food" disabled={f.clash} onPress={save}
          a11y={f.clash ? 'Save food. Unavailable: you already have this food' : `Save food. Saves ${name} to My foods`} />
      </View>
    </KeyboardAvoidingView>
  );
}
