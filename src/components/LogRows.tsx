// v3.2 Log confirm anatomy (frame 4 / 12): every item is the same row:
// neutral tile · name + state chip · muted "qty · oil" · kcal (Space Grotesk 17), tappable (opens Edit).
// Only items needing a real choice sit in a dashed decision card with one helper line and a segmented choice.
import { memo, ReactNode, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { reasonWord } from '../lib/learned';
import { portionLabel } from '../lib/labels';
import { Item, parser } from '../parser';
import { makeStyles, useTheme } from '../theme';
import { FoodTile } from './FoodTile';
import { choose as chooseUnit, unitChoices, unitKey } from '../lib/decision';
import { canAddEstimate, estimateAddLabel, isVague, scaleItem, isVariantChoice, pickUnit, pickVague, pickVariant, vagueChoices, vagueWord, variantOptions } from '../lib/confirmBatch';
import { failedCopy } from '../lib/aiRows';
import { Icon } from './Icon';
import { EditSheet } from './ItemEditor';
import { AddButton, Badge, Row, Segmented, T } from './ui';

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

export const ItemRow = memo(function ItemRow({ it, state, chevron, sub, tableMatch, onEdit, onRemove }: {
  it: Item; state: RowState; chevron?: boolean; sub?: string; tableMatch?: boolean; onEdit: (n: Item) => void; onRemove: () => void;
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
        {tableMatch ? <T v="caption" tone="text2">✓ Table match</T> : null}
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
  sep: { borderTopWidth: 1, borderTopColor: t.c.lineSoft },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, paddingVertical: 10 },
  dotted: { textDecorationLine: 'underline', textDecorationStyle: 'dotted', fontWeight: '500' },
  decision: { borderRadius: t.radius.card, borderWidth: 1.5, borderStyle: 'dashed', borderColor: t.c.text2, paddingHorizontal: t.space.cardH, paddingBottom: t.space.cardV, gap: 8 },
}));

/** Chip text: 'Veg' from 'veg biryani' when the base name is shared, else the full name. */
export const variantLabel = (name: string, base: string) => {
  const b = base.trim().toLowerCase(); let v = name.trim();
  if (b && v.toLowerCase().endsWith(' ' + b)) v = v.slice(0, -(b.length + 1)); else if (b && v.toLowerCase().startsWith(b + ' ')) v = v.slice(b.length + 1);
  return cap(v.trim() || name);
};
const plural = (u: string) => (u === 'katori' ? 'katori' : `${u}s`);
/** Open row (not counted until the user decides): inline AI estimate, estimate_unverified, or unit mismatch.
 * All numbers come from the API item: kcal.best/low/high and unit_options. */
export function OpenRow({ it, kind, onConfirm, onEdit, onRemove, onAdd, text = '' }: {
  /** AI estimate: one tap saves this row at its shown kcal (no footer, no typing) */ onAdd?: (n: Item) => void;
  text?: string; it: Item; kind: 'estimate' | 'unverified' | 'unit'; onConfirm: (n: Item) => void; onEdit: (n: Item) => void; onRemove: () => void;
}) {
  const s = { ...useStyles(), ...useOpenStyles() }; const t = useTheme();
  const [sheet, setSheet] = useState(false);
  const portion = portionLabel(it.quantity, it.unit);
  const n = (x: number) => Math.round(x).toLocaleString('en-IN');
  const opts = it.unit_options ?? [];
  const variants = variantOptions(it); const isVar = kind === 'unit' && isVariantChoice(it);
  // an unpicked variant row is titled by what the user typed ('Biryani'), never the default guess
  const varBase = (it.matched_text || it.name).trim().split(/\s+/).slice(-1)[0] ?? it.name;
  const title = isVar ? cap(it.matched_text || it.name) : cap(it.name);
  const isVg = kind === 'unit' && !isVar && !it.unit_options?.length && isVague(it); const vw = isVg ? vagueWord(it, text) : '';
  const sameUnit = opts.length > 1 && opts.every((o) => o.unit === opts[0].unit);
  const sub = kind === 'estimate' ? `${portion} · usually ${n(it.kcal.low)}–${n(it.kcal.high)}` : kind === 'unverified' ? `${portion} · sources vary` : portion;
  const right = kind === 'unit' ? '—' : kind === 'unverified' ? `~${n(it.kcal.best)}` : n(it.kcal.best);
  return (
    <View style={s.open}>
      <View style={s.row} accessible accessibilityLabel={`${cap(it.name)}, ${sub}, ${isVar ? 'type needs choosing' : isVg ? 'amount needs choosing' : kind === 'unit' ? 'unit needs checking' : `about ${n(it.kcal.best)} calories`}, not counted`}>
        <FoodTile seed={it.dish_id || it.name} category={parser.dishById(it.dish_id)?.category} size={40} />
        <View style={{ flex: 1, gap: 2 }}>
          <Row style={{ gap: 6, flexWrap: 'wrap' }}>
            <T v="bodyStrong">{title}</T>
            {kind === 'unit' ? <View style={s.warnChip}><T v="label" tone="warn">{isVar ? '⚠ Choose type' : isVg ? '⚠ How much?' : '⚠ Check unit'}</T></View> : <Badge kind="ai" label="Estimate" />}
          </Row>
          <T v="caption" tone="muted">{sub}</T>
          {isVg && vw ? <T v="caption" tone="muted">you wrote: {vw}</T> : null}
        </View>
        <View style={{ alignItems: 'flex-end' }}><T v="number">{right}</T><T v="caption" tone="muted">not counted</T></View>
      </View>
      <View style={s.openBody}>
        {kind === 'unverified' ? (
          <View style={s.warnNote}><T v="bodyStrong" tone="warn">Published recipes give {n(it.kcal.low)}–{n(it.kcal.high)} kcal a {it.unit}. Check it matches your {it.unit}.</T></View>
        ) : null}
        {isVar ? (
          <>
            <T tone="text2">{variants.length ? 'Choose type' : 'Choose type: type it again with the kind, e.g. “veg biryani”.'}</T>
            <Row style={{ gap: 8, flexWrap: 'wrap' }}>
              {variants.map((o) => (
                <Pressable key={o.dish_id} onPress={() => onConfirm(pickVariant(it, o))} style={[s.optBtn, { flexBasis: '45%' }]} accessibilityRole="button"
                  accessibilityLabel={`${cap(o.name)}, ${n(o.kcal)} calories`}>
                  <T v="bodyStrong" style={{ textAlign: 'center' }}>{variantLabel(o.name, varBase)} · {n(o.kcal)} kcal</T>
                </Pressable>
              ))}
            </Row>
          </>
        ) : isVg ? (
          <>
            <T tone="text2">How much?</T>
            <Row style={{ gap: 8 }}>
              {vagueChoices(it, scaleItem).map((c) => (
                <Pressable key={c.key} onPress={() => onConfirm(pickVague(c.item))} style={s.optBtn} accessibilityRole="button"
                  accessibilityLabel={`${c.label}, ${portionLabel(c.item.quantity, c.item.unit)}, ${n(c.item.kcal.best)} calories`}>
                  <T v="bodyStrong" style={{ textAlign: 'center' }}>{c.label}</T>
                  <T v="caption" tone="text2" style={{ textAlign: 'center' }}>{portionLabel(c.item.quantity, c.item.unit)} · {n(c.item.kcal.best)} kcal</T>
                </Pressable>
              ))}
            </Row>
          </>
        ) : kind === 'unit' ? (
          <>
            <T tone="text2">{sameUnit ? `${portionLabel(it.quantity, it.unit)} is a lot. Which did you mean?` : `Did you mean ${opts.map((o) => plural(o.unit)).join(' or ')}?`}</T>
            <Row style={{ gap: 8 }}>
              {opts.map((o) => (
                <Pressable key={`${o.qty}|${o.unit}`} onPress={() => onConfirm(pickUnit(it, o))} style={s.optBtn} accessibilityRole="button"
                  accessibilityLabel={`${portionLabel(o.qty, o.unit)}, ${n(o.kcal)} calories`}>
                  <T v="bodyStrong" style={{ textAlign: 'center' }}>{portionLabel(o.qty, o.unit)} · {n(o.kcal)} kcal</T>
                </Pressable>
              ))}
            </Row>
          </>
        ) : (
          <Row style={{ gap: 8 }}>
            {kind === 'estimate' && canAddEstimate(it) ? (
              // ai-estimate-row: outlined coral 'Add · N kcal' (em = darker coral in light, never accentFill), saves only this row
              <Pressable onPress={() => (onAdd ?? onConfirm)({ ...it, needs_confirmation: false })} style={[s.optBtn, { borderColor: t.c.em }]} accessibilityRole="button"
                accessibilityLabel={`Add ${cap(it.name)}, ${n(it.kcal.best)} calories`}>
                <T v="bodyStrong" tone="em">{estimateAddLabel(it)}</T>
              </Pressable>
            ) : (
            <Pressable onPress={() => onConfirm({ ...it, needs_confirmation: false })} style={[s.optBtn, { backgroundColor: t.c.accentFill, borderColor: t.c.accentFill }]} accessibilityRole="button" accessibilityLabel={`Looks right, add ${cap(it.name)}`}>
              <T v="bodyStrong" tone="onAccent">Looks right</T>
            </Pressable>
            )}
            <Pressable onPress={() => setSheet(true)} style={s.optBtn} accessibilityRole="button" accessibilityLabel={`Change portion of ${cap(it.name)}`}>
              <T v="bodyStrong">Change portion</T>
            </Pressable>
          </Row>
        )}
      </View>
      <EditSheet visible={sheet} it={it} onClose={() => setSheet(false)} onSave={(x) => { setSheet(false); onEdit(x); }} onDelete={() => { setSheet(false); onRemove(); }} />
    </View>
  );
}
const useOpenStyles = makeStyles((t) => ({
  open: { paddingBottom: t.space.cardV },
  openBody: { paddingLeft: 52, gap: 8 },
  optBtn: { flex: 1, minHeight: 44, borderRadius: 12, borderWidth: 1.5, borderColor: t.c.cardLine, backgroundColor: t.c.card, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8, paddingVertical: 6 },
  warnChip: { backgroundColor: t.c.warnTint, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 },
  warnNote: { backgroundColor: t.c.warnTint, borderWidth: 1, borderColor: t.c.warnTintLine, borderRadius: 12, padding: 12 },
}));

/** Failed AI estimate (retry failed / busy / daily limit): CUSTOM chip, "—", "not counted", the user's own kcal + Add.
 * Counts only once a kcal value is added; never part of the batch. */
export function FailedAiRow({ row, onKcal, onAdd }: { row: { name: string; kcal: string; added: boolean; reason?: string; userDailyLimit?: number; resetsAt?: string }; onKcal: (v: string) => void; onAdd: () => void }) {
  const s = { ...useStyles(), ...useOpenStyles(), ...useFailedStyles() }; const t = useTheme();
  const k = Number(row.kcal);
  return (
    <View style={s.open}>
      <View style={s.row}>
        <FoodTile seed={row.name} size={40} />
        <View style={{ flex: 1, gap: 2 }}>
          <Row style={{ gap: 6 }}><T v="bodyStrong">{cap(row.name)}</T><Badge kind="brand" label="Custom" /></Row>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <T v="number">{row.added && k > 0 ? Math.round(k).toLocaleString('en-IN') : '—'}</T>
          {row.added && k > 0 ? null : <T v="caption" tone="muted">not counted</T>}
        </View>
      </View>
      {row.added ? null : (
        <View style={s.openBody}>
          <T tone="text2">{failedCopy(row)}</T>
          <Row style={{ gap: 8 }}>
            <TextInput value={row.kcal} onChangeText={onKcal} keyboardType="numeric" placeholder="kcal" placeholderTextColor={t.c.muted}
              accessibilityLabel={`Calories for ${row.name}`} style={[s.kcalInput, { color: t.c.text, borderColor: t.c.muted }]} />
            <AddButton onPress={onAdd} disabled={!(k > 0)} accessibilityLabel={`Add ${row.name}`} />
          </Row>
        </View>
      )}
    </View>
  );
}
const useFailedStyles = makeStyles((t) => ({
  kcalInput: { width: 96, height: 44, borderWidth: 1.5, borderRadius: 12, paddingHorizontal: 12, fontSize: 16, backgroundColor: t.c.card },
}));
