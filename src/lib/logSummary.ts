// Total row + primary button for Log (design-notes "Button and total rules" + "AI-first parser states"). Pure, tested.
export interface LogCounts { kcal: number; protein: number; items: number; estimating: number; pending: number; toConfirm: number; estimates: number; needsKcal: number }
const n = (x: number) => Math.round(x).toLocaleString('en-IN');
export function logSummary(c: LogCounts) {
  const allEstimates = c.items > 0 && c.estimates === c.items && c.estimating === 0 && c.pending === 0 && c.needsKcal === 0;
  let total = 'Total', button = `Add ${n(c.kcal)} kcal`, disabled = c.items + c.pending + c.estimating + c.needsKcal === 0, soFar = false;
  if (c.estimating) { // NOT disabled: Add saves confident items now; estimating ones go to items to review
    total = `Total · ${c.estimating} estimating`; button = `Add ${n(c.kcal)} kcal · ${c.estimating} estimating`; soFar = true;
  } else if (c.needsKcal) {
    total = `Total · ${c.needsKcal} needs kcal`; button = `Add ${n(c.kcal)} kcal · ${c.needsKcal} needs kcal`; disabled = true;
  } else if (allEstimates) {
    total = `Total · ${c.estimates} ${c.estimates === 1 ? 'estimate' : 'estimates'}`; button = `Confirm & add ${n(c.kcal)} kcal`;
  } else if (c.pending) {
    total = `Total · ${c.pending} pending, not counted`; button = `Add ${n(c.kcal)} kcal · ${c.pending} pending`;
  } else if (c.toConfirm) {
    total = `Total · ${c.toConfirm} to confirm`; button = `Confirm ${c.toConfirm} & add ${n(c.kcal)} kcal`;
  }
  return { total, button, disabled, allEstimates, soFar, kcalText: n(c.kcal), protein: Math.round(c.protein) };
}

/** Total of the drafts exactly as shown on their rows (row kcal = item.kcal.best); customs add their typed numbers. */
export function draftTotals(items: { kcal: { best: number }; protein_g: { best: number } }[], customs: { kcal: string; protein: string }[] = []) {
  return {
    kcal: items.reduce((a, i) => a + i.kcal.best, 0) + customs.reduce((a, c) => a + (Number(c.kcal) || 0), 0),
    protein: items.reduce((a, i) => a + i.protein_g.best, 0) + customs.reduce((a, c) => a + (Number(c.protein) || 0), 0),
  };
}
