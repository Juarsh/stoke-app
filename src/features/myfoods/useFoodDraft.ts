// Form state for a My food: the live clash, field errors shown after a Save attempt, and focus on the first error.
import { useCallback, useState } from 'react';
import { clashOf, Draft, draftErrors, Field, FIELD_ORDER, foodFromDraft, MyFood } from './model';

export function useFoodDraft(initial: Draft, all: MyFood[], prev?: MyFood) {
  const [draft, setDraftRaw] = useState(initial);
  const [tried, setTried] = useState(false);
  const [focus, setFocus] = useState<Field | null>(null);
  const clash = !!clashOf(draft.name, all, prev?.id);
  const errors = tried ? draftErrors(draft, all, prev?.id) : {};
  const setDraft = useCallback((d: Draft) => setDraftRaw(d), []);
  const onFocused = useCallback(() => setFocus(null), []);
  /** The food to save, or null (errors shown, focus on the first one). */
  const trySave = (id: string): MyFood | null => {
    setTried(true);
    const f = foodFromDraft(draft, all, { id, prev });
    if (!f) { const e = draftErrors(draft, all, prev?.id); setFocus(FIELD_ORDER.find((k) => e[k]) ?? null); }
    return f;
  };
  const reset = (d: Draft) => { setDraftRaw(d); setTried(false); };
  return { draft, setDraft, clash, errors, focus, onFocused, trySave, reset };
}
