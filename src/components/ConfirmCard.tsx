// Confirm-before-saving cards for did_you_mean (screen 12) and generic (screen 13).
// Neutral styling (text-2 outline, black/white tag) — never purple/amber/red.
import { useState } from 'react';
import { View } from 'react-native';
import type { AnyItem } from '../lib/itemKind';
import { itemKind } from '../lib/itemKind';
import { portionLabel } from '../lib/labels';
import { Alternative, DISHES, Item, parser } from '../parser';
import { FoodTile } from './FoodTile';
import { EditSheet } from './ItemEditor';
import { Badge, Card, Chip, Field, Row, T } from './ui';

export function ConfirmCard({ it, onResolve, onRemove }: { it: AnyItem; onResolve: (x: Item) => void; onRemove: () => void }) {
  const kind = itemKind(it);
  const [edit, setEdit] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [q, setQ] = useState('');
  const dish = parser.dishById(it.dish_id);
  // confirmed by the user; source is kept so the server can re-check it
  const resolved = (x: Item) => ({ ...x, source: it.source, alternatives: undefined, needs_confirmation: false } as Item);
  const pickAlt = (a: Alternative) => onResolve(resolved(parser.edit(it, { quantity: a.quantity, unit: a.unit })));
  const matches = q.length > 1 ? DISHES.filter((d) => d.name.includes(q.toLowerCase())).slice(0, 5) : [];
  return (
    <Card outline="check" accessibilityRole="alert">
      <Row style={{ justifyContent: 'space-between' }}>
        <Row style={{ flex: 1 }}>
          <FoodTile seed={it.dish_id} category={dish?.category} size={36} />
          <View style={{ flex: 1 }}>
            <Row><T v="bodyStrong">{it.name}</T><Badge kind="check" label={kind === 'generic' ? 'Generic' : 'Check'} /></Row>
            <T v="caption" tone="muted">
              {kind === 'generic' ? `${it.matched_text} · matched: ${it.generic_note || it.name}` : it.alternatives?.length ? `${portionLabel(it.quantity, it.unit)} — that’s a lot. Did you mean…?` : `Did you mean ${it.name}? You typed “${it.matched_text}”.`}
            </T>
          </View>
        </Row>
        <T v="number" tone="over">{it.kcal.best.toLocaleString('en-IN')}</T>
      </Row>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {it.alternatives?.length ? (
          <>
            {(it.alternatives ?? []).map((a, i) => (
              <Chip key={i} kind="neutral" selected={i === 0} label={`${portionLabel(a.quantity, a.unit)} (~${a.kcal} kcal)`} a11y={`${a.label}: ${portionLabel(a.quantity, a.unit)}, about ${a.kcal} calories`} onPress={() => pickAlt(a)} />
            ))}
            <Chip kind="neutral" label={`${portionLabel(it.quantity, it.unit)} (${it.kcal.best.toLocaleString('en-IN')})`} a11y="Keep as typed" onPress={() => onResolve(resolved(it))} />
          </>
        ) : (
          <>
            <Chip kind="neutral" selected label="✓ Looks right" onPress={() => onResolve(resolved(it))} />
            <Chip kind="neutral" label="Switch dish" onPress={() => setSwitching((v) => !v)} />
          </>
        )}
        <Chip kind="neutral" label="Edit" onPress={() => setEdit(true)} />
        <Chip kind="neutral" label="Remove" onPress={onRemove} />
      </View>
      {switching ? (
        <View style={{ gap: 4 }}>
          <Field placeholder="Search our dishes…" value={q} onChangeText={setQ} accessibilityLabel="Switch dish" />
          {matches.map((d) => <Chip key={d.id} kind="neutral" label={d.name} onPress={() => onResolve(resolved(parser.edit(it, { dishId: d.id, quantity: 1 })))} />)}
        </View>
      ) : null}
      <EditSheet visible={edit} it={it} onClose={() => setEdit(false)} onSave={(n) => { setEdit(false); onResolve(resolved(n)); }} onDelete={() => { setEdit(false); onRemove(); }} />
    </Card>
  );
}
