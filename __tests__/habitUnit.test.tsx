// Bug (Akarsh, iPhone): every Count target showed "glass". A count defaults to the neutral "times"; only Water suggests
// glasses; the unit is optional free text (trimmed, at most 16 characters, empty → "times"); stored units show as stored.
import { blankDraft, defaultUnit, draftErrors, draftOf, fromDraft, Habit, metaLine, unitOf } from '../src/features/habits/model';
import { habitBody, habitOf } from '../src/lib/docRows';

const H = (p: Partial<Habit>): Habit => ({ id: 'h1', name: 'Pray', short_name: 'Pray', short_name_auto: true, icon: null, kind: 'count', target_value: 5, unit: 'times',
  target_sets: null, target_reps: null, schedule: 'daily', weekdays: 127, starts_on: '2026-10-01', position: 0, archived_at: null, created_at: '', updated_at: '', ...p });

describe('count unit default', () => {
  test('neutral "times" unless the habit is water', () => {
    expect(blankDraft().unit).toBe('times');
    expect(defaultUnit('')).toBe('times');
    expect(defaultUnit('Pray')).toBe('times');
    expect(defaultUnit('Read 10 pages')).toBe('times');
    expect(defaultUnit('Drink water')).toBe('glasses');
    expect(defaultUnit('Water 8 glasses')).toBe('glasses');
    expect(defaultUnit('Watermelon')).toBe('times');
  });
  test('free text: trimmed, spaces collapsed, empty falls back to times', () => {
    expect(unitOf('  laps ')).toBe('laps');
    expect(unitOf('big   cups')).toBe('big cups');
    expect(unitOf('')).toBe('times');
    expect(unitOf('   ')).toBe('times');
    const d = { ...blankDraft(), name: 'Swim', short_name: 'Swim', kind: 'count' as const, unit: '  laps ' };
    expect(draftErrors(d, [])).toEqual({});
    expect(fromDraft(d).unit).toBe('laps');
    expect(fromDraft({ ...d, unit: '' }).unit).toBe('times');
  });
  test('too long or steps is refused with the reason, never cut', () => {
    const d = { ...blankDraft(), name: 'Swim', short_name: 'Swim', kind: 'count' as const };
    expect(draftErrors({ ...d, unit: 'x'.repeat(17) }, []).target).toBe('Unit can be at most 16 characters.');
    expect(draftErrors({ ...d, unit: 'x'.repeat(16) }, []).target).toBeUndefined();
    expect(draftErrors({ ...d, unit: ' Steps ' }, []).target).toBe('Steps are on the Food card, so they can’t be a habit.');
  });
  test('a habit saved with "glass" (the bug) shows and edits as stored, and round-trips the server body', () => {
    const h = H({ unit: 'glass' });
    expect(metaLine(h)).toBe('5 glass · Every day');
    expect(draftOf(h).unit).toBe('glass');
    expect(fromDraft(draftOf(h)).unit).toBe('glass');
    const laps = H({ unit: 'laps' });
    expect(habitOf({ id: 'h1', ...habitBody(laps) } as never).unit).toBe('laps');
  });
});
