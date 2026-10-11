import type { Item } from '../parser';
import { portionLabel } from '../lib/labels';
import { Card, Chip, Row, T } from './ui';

/** "Did you mean…?" — info styling (blue), deliberately distinct from the purple AI badge. */
export function DidYouMean({ it, alternatives, onPick }: { it: Item; alternatives: Item[]; onPick: (x: Item) => void }) {
  return (
    <Card tone="infoSoft" accessibilityRole="alert">
      <T v="bodyStrong" tone="infoText">Did you mean…? {portionLabel(it.quantity, it.unit)} {it.name} is {it.kcal.best} kcal.</T>
      <Row style={{ flexWrap: 'wrap', gap: 6 }}>
        {alternatives.map((a) => (
          <Chip key={`${a.quantity}${a.unit}`} kind="neutral" label={`${portionLabel(a.quantity, a.unit)} · ${a.kcal.best} kcal`} onPress={() => onPick(a)} a11y={`Use ${portionLabel(a.quantity, a.unit)}, ${a.kcal.best} calories`} />
        ))}
        <Chip kind="neutral" label={`Yes, ${portionLabel(it.quantity, it.unit)}`} onPress={() => onPick(it)} a11y={`Keep ${portionLabel(it.quantity, it.unit)}`} />
      </Row>
    </Card>
  );
}
