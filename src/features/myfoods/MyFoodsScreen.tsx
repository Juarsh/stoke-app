// §6.2 / §6.6 My foods: rows "name · unit · kcal ›" open the edit sheet; Save; quiet "Delete food" = immediate soft
// delete, back on the list with "<name> deleted · Undo". Empty: "Foods you add show up here." + outlined New food.
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '@/components/Icon';
import { T } from '@/components/ui';
import { useStore } from '@/lib/store';
import { useTheme } from '@/theme';
import { amountLabel } from '@/features/logfood/model';
import { FoodForm } from './FoodForm';
import { activeFoods, draftOf, MyFood } from './model';
import { SaveButton } from './SaveButton';
import { useFoodDraft } from './useFoodDraft';

const kc = (n: number) => Math.round(n).toLocaleString('en-IN');

export function MyFoodsScreen() {
  const t = useTheme(); const ins = useSafeAreaInsets(); const router = useRouter(); const st = useStore();
  const foods = activeFoods(st.myFoods).slice().sort((a, b) => a.name.localeCompare(b.name));
  const [editing, setEditing] = useState<MyFood | null>(null);
  const [toast, setToast] = useState<{ id: string; name: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const del = (f: MyFood) => {
    st.deleteMyFood(f.id); setEditing(null);
    if (timer.current) clearTimeout(timer.current);
    setToast({ id: f.id, name: f.name });
    timer.current = setTimeout(() => setToast(null), 4000);
  };
  const newFood = () => router.push('/my-food-new');
  return (
    <View style={{ flex: 1, backgroundColor: t.c.bg }}>
      <View style={{ paddingTop: ins.top + 6, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', minHeight: 56 + ins.top }}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" style={{ width: 48, height: 48, marginLeft: -14, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="back" color={t.c.text} size={22} strokeWidth={2.2} />
        </Pressable>
        <T v="title" accessibilityRole="header" style={{ fontSize: 22, flex: 1 }}>My foods</T>
        <Pressable onPress={newFood} accessibilityRole="button" accessibilityLabel="New food" style={{ minHeight: 48, justifyContent: 'center', paddingLeft: 8 }}>
          <T v="bodyStrong" style={{ color: t.c.accentText, fontSize: 15 }}>+ New food</T>
        </Pressable>
      </View>
      {foods.length ? (
        <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 10 }}>
          <View style={{ backgroundColor: t.c.card, borderRadius: t.radius.card, borderWidth: 1, borderColor: t.c.lineSoft, paddingVertical: 4 }}>
            {foods.map((f, i) => (
              <Pressable key={f.id} onPress={() => setEditing(f)} accessibilityRole="button" accessibilityLabel={`${f.name}, ${amountLabel(f.unit, f.amount)}, ${kc(f.kcal)} kcal. Edit`}
                style={{ flexDirection: 'row', alignItems: 'center', minHeight: 60, paddingLeft: 16, paddingRight: 12, gap: 6, borderTopWidth: i ? 1 : 0, borderTopColor: t.c.lineSoft }}>
                <T v="bodyStrong" style={{ fontSize: 17, flexShrink: 1 }} numberOfLines={1}>{f.name}</T>
                <T tone="muted" style={{ fontSize: 15, flexShrink: 0 }} numberOfLines={1}>· {amountLabel(f.unit, f.amount)}</T>
                <View style={{ flex: 1 }} />
                <T v="number" style={{ fontSize: 18 }}>{kc(f.kcal)}</T>
                <Icon name="chev" color={t.c.muted} size={18} strokeWidth={2.2} />
              </Pressable>
            ))}
          </View>
        </ScrollView>
      ) : (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, paddingBottom: 80 }}>
          <T tone="muted" style={{ fontSize: 15, textAlign: 'center' }}>Foods you add show up here.</T>
          <Pressable onPress={newFood} accessibilityRole="button" accessibilityLabel="New food"
            style={{ minHeight: 48, paddingHorizontal: 20, borderRadius: t.radius.button, borderWidth: 1.5, borderColor: t.c.cardLine, alignItems: 'center', justifyContent: 'center' }}>
            <T v="bodyStrong" style={{ fontSize: 15 }}>+ New food</T>
          </Pressable>
        </View>
      )}
      {toast ? (
        <View accessibilityLiveRegion="polite" accessibilityRole="alert" style={{ position: 'absolute', left: 20, right: 20, bottom: 20 + ins.bottom, flexDirection: 'row', alignItems: 'center', borderRadius: 14, backgroundColor: t.c.popBg, paddingLeft: 16 }}>
          <T style={{ flex: 1, color: t.c.popText, paddingVertical: 12 }}>{toast.name} deleted</T>
          <Pressable onPress={() => { st.restoreMyFood(toast.id); setToast(null); }} accessibilityRole="button" accessibilityLabel="Undo delete" style={{ minWidth: 64, height: 48, alignItems: 'center', justifyContent: 'center' }}>
            <T v="bodyStrong" style={{ color: t.dark ? t.c.accentText : t.c.onNavPlus }}>Undo</T>
          </Pressable>
        </View>
      ) : null}
      {editing ? <EditFoodSheet food={editing} all={st.myFoods} onClose={() => setEditing(null)} onSave={(f) => { st.saveMyFood(f); setEditing(null); }} onDelete={() => del(editing)} /> : null}
    </View>
  );
}

export function EditFoodSheet({ food, all, onClose, onSave, onDelete }: { food: MyFood; all: MyFood[]; onClose: () => void; onSave: (f: MyFood) => void; onDelete: () => void }) {
  const t = useTheme(); const ins = useSafeAreaInsets();
  const f = useFoodDraft(draftOf(food), all, food);
  const lower = food.name.toLowerCase();
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: t.c.scrim }} onPress={onClose} accessibilityLabel="Close" />
      <View accessibilityViewIsModal style={{ backgroundColor: t.c.sheet, borderTopLeftRadius: t.radius.sheet, borderTopRightRadius: t.radius.sheet, maxHeight: '92%',
        paddingHorizontal: 24, paddingTop: 10, paddingBottom: 12 + ins.bottom, ...(t.dark ? { borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)' } : {}) }}>
        <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: t.c.handle, alignSelf: 'center', marginBottom: 14 }} />
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <T v="title" accessibilityRole="header" style={{ fontSize: 22, flex: 1 }} numberOfLines={2}>{food.name}</T>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" style={{ width: 48, height: 48, alignItems: 'center', justifyContent: 'center', marginRight: -12 }}>
            <Icon name="x" color={t.c.text} size={20} strokeWidth={2.2} />
          </Pressable>
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" style={{ marginTop: 8 }}>
          <FoodForm card={false} draft={f.draft} onChange={f.setDraft} errors={f.errors} clash={f.clash} focus={f.focus} onFocused={f.onFocused} />
        </ScrollView>
        <View style={{ marginTop: 8 }}>
          <SaveButton title="Save" disabled={f.clash} onPress={() => { const n = f.trySave(food.id); if (n) onSave(n); }}
            a11y={f.clash ? 'Save. Unavailable: you already have this food' : `Save changes to ${lower}`} />
        </View>
        <Pressable onPress={onDelete} accessibilityRole="button" accessibilityLabel={`Delete food, ${lower}. Past logs keep their values`}
          style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 4 }}>
          <Icon name="trash" color={t.c.muted} size={16} strokeWidth={2} />
          <T v="bodyStrong" tone="muted" style={{ fontSize: 15 }}>Delete food</T>
        </Pressable>
      </View>
    </Modal>
  );
}
