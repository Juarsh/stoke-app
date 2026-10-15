// v3.2 Log confirm anatomy (frame 4 / 12): every item is the same row:
// neutral tile · name + state chip · muted "qty · oil" · kcal (Space Grotesk 17), tappable (opens Edit).
// Only items needing a real choice sit in a dashed decision card with one helper line and a segmented choice.
import { memo, ReactNode, useState } from 'react';
import { Pressable, View } from 'react-native';
import { reasonWord } from '../lib/learned';
import { portionLabel } from '../lib/labels';
import { Item, parser } from '../parser';
import { makeStyles, useTheme } from '../theme';
import { FoodTile } from './FoodTile';
import { choose as chooseUnit, unitChoices, unitKey } from '../lib/decision';
import { Icon } from './Icon';
import { EditSheet } from './ItemEditor';
import { Badge, Row, Segmented, T } from './ui';

export type RowState = 'plain' | 'remembered' | 'check' | 'estimate';
const chipOf = (it: Item, state: RowState): { label: string; kind: 'brand' | 'check' | 'ai' } | null => {
  if (state === 'remembered') return { label: 'Remembered', kind: 'brand' };
  if (state === 'check') return { label: 'Check', kind: 'check' };
  if (state === 'estimate') return { label: 'Estimate', kind: 'ai' };
  return parser.dishById(it.dish_id)?.brand ? { label: 'Brand', kind: 'brand' } : null;
};

/** Grouped list card: rows separated by hairlines. */
export function Group({ children }: { children: ReactNode }) {
  const s = useStyles();
  const kids = (Array.isArray(children) ? children : [children]).filter(Boolean);
  return <View style={s.group}>{kids.map((c, i) => <View key={i} style={i > 0 ? s.sep : undefined}>{c}</View>)}</View>;
}

export const ItemRow = memo(function ItemRow({ it, state, chevron, sub, onEdit, onRemove }: {
  it: Item; state: RowState; chevron?: boolean; sub?: string; onEdit: (n: Item) => void; onRemove: () => void;
}) {
  const s = useStyles(); const t = useTheme();
  const [sheet, setSheet] = useState(false);
  const chip = chipOf(it, state);
  const portion = portionLabel(it.quantity, it.unit);
  const extra = sub ?? [it.oil_level ? `oil ${it.oil_level}` : '', it.ai_estimate ? 'AI estimate, not in our table' : ''].filter(Boolean).join(' · ');
  return (
    <Pressable style={s.row} onPress={() => setSheet(true)} accessibilityRole="button"
      accessibilityLabel={`${it.name}, ${portion}, ${it.kcal.best} calories${chip ? `, ${chip.label}` : ''}. Double-tap to edit`}>
      <FoodTile seed={it.dish_id || it.name} category={parser.dishById(it.dish_id)?.category} size={40} />
      <View style={{ flex: 1, gap: 2 }}>
        <Row style={{ gap: 6, flexWrap: 'wrap' }}><T v="bodyStrong">{cap(it.name)}</T>{chip ? <Badge kind={chip.kind} label={chip.label} /> : null}</Row>
        {it.default_portion && !it.ai_estimate ? (
          <T v="caption" tone="muted">
            <T v="caption" tone="text" style={s.dotted} onPress={() => setSheet(true)}>{portion}</T>
            {' · '}<T v="caption" tone="em" style={{ fontWeight: '600' }} onPress={() => setSheet(true)}>Change</T>
            {extra ? ` · ${extra}` : ''}
          </T>
        ) : <T v="caption" tone="muted">{[portion, extra].filter(Boolean).join(' · ')}</T>}
      </View>
      <T v="number">{it.kcal.best.toLocaleString('en-IN')}</T>
      {chevron ? <Icon name="chevron" color={t.c.muted} size={18} /> : null}
      <EditSheet visible={sheet} it={it} onClose={() => setSheet(false)} onSave={(n) => { setSheet(false); onEdit(n); }} onDelete={() => { setSheet(false); onRemove(); }} />
    </Pressable>
  );
});

/** Dashed decision card: only for items needing a real choice in a mixed list. */
export function DecisionCard({ it, onPick, onEdit, onRemove }: { it: Item; onPick: (n: Item) => void; onEdit: (n: Item) => void; onRemove: () => void }) {
  const s = useStyles();
  const [sheet, setSheet] = useState(false);
  const alts = it.alternatives ?? [];
  let helper: string, opts: { value: string; label: string }[], value: string, choose: (v: string) => void;
  const ok = () => onPick({ ...it, needs_confirmation: false, alternatives: undefined });
  if (alts.length) {
    const a = alts[0];
    const cs = unitChoices(it);
    helper = `Did you mean ${a.unit === 'piece' ? 'pieces' : portionLabel(a.quantity, a.unit)} or ${it.unit}s?`;
    opts = cs.map((c) => ({ value: c.key, label: c.label }));
    value = unitKey(it); // highlight = the unit the shown kcal is computed for (never a different one)
    choose = (v) => onPick(chooseUnit(it, v));
  } else if (it.ai_estimate) {
    helper = ''; opts = [{ value: 'use', label: 'Use estimate' }, { value: 'own', label: 'Enter my own' }]; value = 'use';
    choose = (v) => (v === 'use' ? ok() : setSheet(true));
  } else {
    helper = `Read as ${it.name} · ${reasonWord(it)}`;
    opts = [{ value: 'ok', label: 'Looks right' }, { value: 'change', label: 'Change' }]; value = 'ok';
    choose = (v) => (v === 'ok' ? ok() : setSheet(true));
  }
  return (
    <View style={s.decision}>
      <ItemRow it={it} state={it.ai_estimate ? 'estimate' : 'check'} chevron onEdit={onEdit} onRemove={onRemove} />
      {helper ? <T v="caption" tone="text2">{helper}</T> : null}
      <Segmented value={value} options={opts} onChange={choose} />
      <EditSheet visible={sheet} it={it} onClose={() => setSheet(false)} onSave={(n) => { setSheet(false); onPick({ ...n, needs_confirmation: false }); }} onDelete={() => { setSheet(false); onRemove(); }} />
    </View>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const useStyles = makeStyles((t) => ({
  group: { backgroundColor: t.c.card, borderRadius: t.radius.card, borderWidth: 1, borderColor: t.c.line, paddingHorizontal: t.space.cardH },
  sep: { borderTopWidth: 1, borderTopColor: t.c.line },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, paddingVertical: 10 },
  dotted: { textDecorationLine: 'underline', textDecorationStyle: 'dotted', fontWeight: '500' },
  decision: { borderRadius: t.radius.card, borderWidth: 1.5, borderStyle: 'dashed', borderColor: t.c.text2, paddingHorizontal: t.space.cardH, paddingBottom: t.space.cardV, gap: 8 },
}));
