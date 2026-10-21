// One plan (item 9): its name, which routine sits on each day of the week (or Rest), its routines, make it the active
// plan, and Delete. Every change is saved on the phone at once through the plans store (checks first, reason shown).
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { Field, T } from '@/components/ui';
import { usePlans } from '@/lib/plans';
import { useTheme } from '@/theme';
import { countLabel, daysLabel, WEEKDAYS } from './model';
import { Box, Confirm, Header, HoneyButton, TextLink } from './parts';

const LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function PlanScreen({ id }: { id: string }) {
  const t = useTheme(); const router = useRouter(); const plans = usePlans();
  const plan = plans.planById(id);
  const [name, setName] = useState(plan?.name ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [day, setDay] = useState<number | null>(null);
  const [del, setDel] = useState(false);
  useEffect(() => { setName(plan?.name ?? ''); }, [plan?.name]);
  if (!plans.ready) return <View style={{ flex: 1, backgroundColor: t.c.bg }} />;
  if (!plan) return <View style={{ flex: 1, backgroundColor: t.c.bg }}><Header title="Plan" /><T tone="text2" style={{ padding: 20 }}>This plan was deleted.</T></View>;
  const active = plans.state.activeId === plan.id;
  const rename = () => { if (name.trim() === plan.name) return; const e = plans.renamePlan(plan.id, name.trim()); setErr(e); if (e) setName(plan.name); };
  const newRoutine = (weekday?: number) => router.push({ pathname: '/routine/[id]', params: { id: 'new', plan: plan.id, ...(weekday !== undefined ? { day: String(weekday) } : {}) } } as never);
  const pickDay = (routineId: string | null) => { if (day === null) return; setErr(plans.setDay(plan.id, day, routineId)); setDay(null); };
  const divider = { borderTopWidth: 1, borderTopColor: t.c.lineSoft } as const;
  return (
    <View style={{ flex: 1, backgroundColor: t.c.bg }}>
      <Header title="Edit plan" right={<TextLink title="Delete" onPress={() => setDel(true)} a11y={`Delete ${plan.name}`} />} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, gap: 14, paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
        <Field label="Plan name" value={name} onChangeText={setName} onBlur={rename} onSubmitEditing={rename} maxLength={40} accessibilityLabel="Plan name" />
        {err ? <T tone="warn" accessibilityLiveRegion="polite" style={{ fontSize: 14 }}>{err}</T> : null}
        {active ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ backgroundColor: t.c.accentTint, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 }}><T v="eyebrow" style={{ color: t.c.accentText, fontSize: 12 }}>Active</T></View>
            <T tone="text2" style={{ fontSize: 14, flex: 1 }}>Home and Train show today’s routine from this plan.</T>
          </View>
        ) : <HoneyButton title="Make this my plan" onPress={() => plans.setActive(plan.id)} />}

        <Box>
          <T v="bodyStrong" accessibilityRole="header" style={{ fontSize: 16, paddingHorizontal: 18, paddingVertical: 14 }}>Your week</T>
          {WEEKDAYS.map((d, i) => {
            const r = plan.routines.find((x) => x.id === plan.days[i]);
            return (
              <Pressable key={d} onPress={() => setDay(i)} accessibilityRole="button" accessibilityLabel={`${LONG[i]}: ${r ? r.name : 'Rest'}. Change`}
                style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: 18, ...divider, opacity: pressed ? 0.85 : 1 })}>
                <T v="bodyStrong" tone="text2" style={{ width: 44, fontSize: 14 }}>{d}</T>
                {r ? null : <Icon name="moon" color={t.c.muted} size={16} />}
                <T v={r ? 'bodyStrong' : 'body'} tone={r ? 'text' : 'muted'} style={{ flex: 1, fontSize: 16 }}>{r ? r.name : 'Rest'}</T>
                <Icon name="down" color={t.c.text2} size={18} strokeWidth={2.2} />
              </Pressable>
            );
          })}
        </Box>

        <Box>
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 18, paddingRight: 12 }}>
            <T v="bodyStrong" accessibilityRole="header" style={{ fontSize: 16, flex: 1 }}>Routines</T>
            <TextLink title="+ New routine" onPress={() => newRoutine()} a11y="New routine" />
          </View>
          {plan.routines.length ? plan.routines.map((r) => (
            <Pressable key={r.id} onPress={() => router.push({ pathname: '/routine/[id]', params: { id: r.id, plan: plan.id } } as never)}
              accessibilityRole="button" accessibilityLabel={`${r.name}, ${countLabel(r.exercises.length)}, ${daysLabel(plan, r.id)}. Edit routine`}
              style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 60, paddingHorizontal: 18, paddingVertical: 8, ...divider, opacity: pressed ? 0.85 : 1 })}>
              <View style={{ flex: 1 }}>
                <T v="bodyStrong" style={{ fontSize: 16 }}>{r.name}</T>
                <T tone="muted" style={{ fontSize: 14 }}>{countLabel(r.exercises.length)} · {daysLabel(plan, r.id)}</T>
              </View>
              <Icon name="chev" color={t.c.text2} size={18} strokeWidth={2.2} />
            </Pressable>
          )) : <T tone="muted" style={{ fontSize: 14, paddingHorizontal: 18, paddingBottom: 16 }}>No routines yet. Add one, then put it on a day.</T>}
        </Box>
      </ScrollView>

      <Modal visible={day !== null} transparent animationType="slide" onRequestClose={() => setDay(null)}>
        <Pressable style={{ flex: 1, backgroundColor: t.c.scrim }} onPress={() => setDay(null)} accessibilityLabel="Close" />
        <View style={{ backgroundColor: t.c.sheet, borderTopLeftRadius: t.radius.sheet, borderTopRightRadius: t.radius.sheet, padding: 20, paddingBottom: 32, gap: 4 }}>
          <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: t.c.handle, alignSelf: 'center', marginBottom: 10 }} />
          <T v="title" accessibilityRole="header" style={{ fontSize: 22, marginBottom: 6 }}>{day !== null ? LONG[day] : ''}</T>
          <View accessibilityRole="radiogroup">
            {[...plan.routines.map((r) => ({ id: r.id as string | null, label: r.name })), { id: null, label: 'Rest' }].map((o) => {
              const on = day !== null && plan.days[day] === o.id;
              return (
                <Pressable key={o.id ?? 'rest'} onPress={() => pickDay(o.id)} accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={o.label}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, borderTopWidth: 1, borderTopColor: t.c.sheetLine }}>
                  <View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: on ? t.c.honeyEdge : t.c.stateLine, alignItems: 'center', justifyContent: 'center' }}>
                    {on ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: t.c.honeyEdge }} /> : null}
                  </View>
                  <T v={on ? 'bodyStrong' : 'body'} style={{ fontSize: 16 }}>{o.label}</T>
                </Pressable>
              );
            })}
          </View>
          <TextLink title="+ New routine for this day" onPress={() => { const d = day ?? undefined; setDay(null); newRoutine(d); }} />
        </View>
      </Modal>
      <Confirm visible={del} title={`Delete ${plan.name}?`} body="Its routines go with it. Past workouts stay in your history." keep="Keep plan" drop="Delete plan"
        onKeep={() => setDel(false)} onDrop={() => { setDel(false); plans.deletePlan(plan.id); router.back(); }} />
    </View>
  );
}
