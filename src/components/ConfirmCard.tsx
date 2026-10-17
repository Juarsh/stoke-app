// CHECK card (design-notes "Log confirm patterns"): lighter than a card, dashed text-2
// border, CHECK tag + reason word, "Read as: … · Change". Not a blocker: the batch
// "All look right" button confirms it. Change = quick fixes / dish switcher; tapping
// the card opens the Edit sheet. Any correction is confirmed and remembered.
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { reasonWord } from '../lib/learned';
import { portionLabel } from '../lib/labels';
import { displayName } from '../lib/domain';
import { Alternative, DISHES, Item, parser } from '../parser';
import { makeStyles } from '../theme';
import { EditSheet } from './ItemEditor';
import { Badge, Chip, Field, Row, T } from './ui';

export function ConfirmCard({ it, onResolve, onRemove }: { it: Item; onResolve: (x: Item) => void; onRemove: () => void }) {
  const s = useStyles();
  const [edit, setEdit] = useState(false);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const fixed = (x: Item) => ({ ...x, source: it.source, alternatives: undefined, needs_confirmation: false } as Item);
  const pickAlt = (a: Alternative) => onResolve(fixed(parser.edit(it, { quantity: a.quantity, unit: a.unit })));
  const matches = q.length > 1 ? DISHES.filter((d) => d.name.includes(q.toLowerCase())).slice(0, 5) : [];
  return (
    <Pressable onPress={() => setEdit(true)} style={s.card} accessibilityRole="button" accessibilityLabel={`Check: read as ${displayName(it.name, it.dish_id)}, ${portionLabel(it.quantity, it.unit)}, ${it.kcal.best} calories. Double-tap to edit.`}>
      <Row style={{ justifyContent: 'space-between' }}>
        <Row style={{ flex: 1 }}><Badge kind="check" label="Check" /><T v="caption" tone="muted">{reasonWord(it)}</T></Row>
        <T v="number">{it.kcal.best.toLocaleString('en-IN')}</T>
      </Row>
      <T>
        <T tone="text2">Read as: </T><T v="bodyStrong">{displayName(it.name, it.dish_id)} · {portionLabel(it.quantity, it.unit)}</T>
        <T tone="text2"> · </T><T v="bodyStrong" tone="em" onPress={() => setOpen((v) => !v)} accessibilityRole="button">Change</T>
      </T>
      {it.matched_text && it.matched_text !== it.name ? <T v="caption" tone="muted">You typed “{it.matched_text}”</T> : null}
      {open ? (
        <View style={{ gap: 6 }}>
          <Row style={{ flexWrap: 'wrap', gap: 6 }}>
            {(it.alternatives ?? []).map((a, i) => (
              <Chip key={i} kind="neutral" selected={i === 0} label={`${portionLabel(a.quantity, a.unit)} (~${a.kcal})`} a11y={`${a.label}, about ${a.kcal} calories`} onPress={() => pickAlt(a)} />
            ))}
            <Chip kind="neutral" label="Edit" onPress={() => setEdit(true)} />
            <Chip kind="neutral" label="Remove" onPress={onRemove} />
          </Row>
          <Field placeholder="Switch dish…" value={q} onChangeText={setQ} accessibilityLabel="Switch dish" />
          {matches.map((d) => <Chip key={d.id} kind="neutral" label={d.name} onPress={() => onResolve(fixed(parser.edit(it, { dishId: d.id, quantity: 1 })))} />)}
        </View>
      ) : null}
      <EditSheet visible={edit} it={it} onClose={() => setEdit(false)} onSave={(n) => { setEdit(false); onResolve(fixed(n)); }} onDelete={() => { setEdit(false); onRemove(); }} />
    </Pressable>
  );
}
const useStyles = makeStyles((t) => ({
  card: { borderRadius: t.radius.card, paddingVertical: t.space.cardV, paddingHorizontal: t.space.cardH, gap: t.space.xs,
    borderWidth: 1, borderStyle: 'dashed', borderColor: t.c.text2, backgroundColor: 'transparent' },
}));
