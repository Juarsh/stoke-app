// Item 8, Exercises library (spec §9): the curated wger rows (source and licence on every row), search ranking, the
// Equipment and muscle filters, the credit line, the data layer seam, and the list / how-to screens (placeholder demo).
import React from 'react';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { TextInput } from 'react-native';

jest.mock('../src/lib/config', () => ({ config: { mock: true, mockAi: false, mockAiDelay: 0 }, flags: {} }));
let mockSaved: string | null = null;
jest.mock('../src/lib/kv', () => ({ kv: { get: async () => mockSaved, set: async (_k: string, v: string) => { mockSaved = v; } } }));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'x' }));
jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual('react-native');
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ back: jest.fn(), push: mockPush }) }));

import { bundledExercises, Exercise, exercises } from '../src/lib/exercises';
import { allAuthors, closest, creditLine, equipmentOf, NO_FILTERS, rank, resultsLine, search, words } from '../src/features/library/model';
import { StoreProvider } from '../src/lib/store';
import { LibraryScreen } from '../src/features/library/LibraryScreen';
import { ExerciseScreen } from '../src/features/library/ExerciseScreen';
import { CreditsScreen } from '../src/features/library/CreditsScreen';

const ALL = exercises.all();
const names = (xs: readonly Exercise[]) => xs.map((e) => e.name);
const ex = (name: string, o: Partial<Exercise> = {}): Exercise => ({ id: name, name, aliases: [], group: 'Back', equipment: 'Cable', primary_muscles: ['Lats'], secondary_muscles: [],
  type: 'weight_reps', steps: ['a step', 'another'], source: 'wger', source_ref: 'https://wger.de/exercise/1/view-base', wger_id: 1, wger_translation_id: 1,
  licence: 'CC-BY-SA-4.0', licence_url: 'https://creativecommons.org/licenses/by-sa/4.0/', licence_authors: ['A'], data_licence: 'CC-BY-SA-4.0', data_licence_author: 'A',
  adapted: true, art_origin: null, video_url: null, video_channel: null, ...o });

describe('the curated wger export', () => {
  test('150–250 rows (Q22), unique ids and unique names/aliases (§12.6 name_norm)', () => {
    expect(ALL.length).toBeGreaterThanOrEqual(150);
    expect(ALL.length).toBeLessThanOrEqual(250);
    expect(new Set(ALL.map((e) => e.id)).size).toBe(ALL.length);
    const keys = ALL.flatMap((e) => [e.name, ...e.aliases]).map((s) => words(s).join(' '));
    expect(keys.length - new Set(keys).size).toBe(0);
  });
  test('names are English and not numbered variants (no "mit", no "Bear Walk 2")', () => {
    for (const e of ALL) {
      expect(e.name).not.toMatch(/\b(mit|und|auf|zum|zur|der|das|ohne|bizeps|trizeps|con|avec|sur|para)\b|[À-ÿ]/i);
      expect(e.name.trim()).not.toMatch(/\s(\d+|\(\d+\)|v\d+)$/i);
    }
  });
  test('steps are instructions: intro sentences ("This exercise …", "X is a … exercise", "… targets …") are dropped, ≥ 2 left', () => {
    for (const e of ALL) {
      expect(e.steps.length).toBeGreaterThanOrEqual(2);
      for (const s of e.steps) {
        expect(s).not.toMatch(/^(this|these)( \w+)? (exercise|movement|is)\b|^[^.:]{0,80}?\b(is|are) (a|an|another) [^.]*\b(exercise|variation|movement)\b/i);
        if (!/^(lean|stand|sit|lie|lay|hold|grab|grip|place|put|take|start|begin|bend|step)\b/i.test(s)) expect(s).not.toMatch(/\btargets?\b/i);
      }
    }
  });
  test('every row records its source and licence (§9.7): wger id, page, licence + URL, authors for BY-SA, data licence', () => {
    for (const e of ALL) {
      expect(e.source).toBe('wger');
      expect(e.wger_id).toBeGreaterThan(0);
      expect(e.source_ref).toBe(`https://wger.de/exercise/${e.wger_id}/view-base`);
      expect(['CC-BY-SA-4.0', 'CC-BY-SA-3.0', 'CC0-1.0']).toContain(e.licence);
      expect(e.licence_url).toMatch(/^https:\/\/creativecommons\.org\//);
      expect(['CC-BY-SA-4.0', 'CC-BY-SA-3.0', 'CC0-1.0']).toContain(e.data_licence);
      if (e.licence !== 'CC0-1.0') expect(e.licence_authors.length).toBeGreaterThan(0);
      expect(e.steps.length).toBeGreaterThanOrEqual(2);
      expect(e.primary_muscles.length).toBeGreaterThan(0);
      expect(e.art_origin).toBeNull(); // no third-party art, no media
    }
  });
  test('every row is in the wger snapshot with the same licence (nothing invented)', () => {
    const snap = JSON.parse(readFileSync(join(__dirname, '../tools/wger/snapshot.json'), 'utf8')).rows as { id: number; t: { id: number; name: string; license: number } }[];
    const byId = new Map(snap.map((r) => [r.id, r]));
    const LIC: Record<number, string> = { 1: 'CC-BY-SA-3.0', 2: 'CC-BY-SA-4.0', 3: 'CC0-1.0' };
    for (const e of ALL) {
      const r = byId.get(e.wger_id)!;
      expect(r).toBeDefined();
      expect(r.t.id).toBe(e.wger_translation_id);
      expect(LIC[r.t.license]).toBe(e.licence);
      expect(words(r.t.name)).toEqual(words(e.name));
    }
  });
});

describe('search ranking (name and alias)', () => {
  const repo = bundledExercises([ex('Dumbbell Bench Press'), ex('Bench Press'), ex('Bench Dips'), ex('Incline Bench Press'), ex('Close-grip press', { aliases: ['Narrow bench press'] }),
    ex('Benchmark row'), ex('Push-Ups'), ex('Knee push-ups')]);
  test('exact name, then name prefix, then every word starting a name word, then alias, then inside a word', () => {
    expect(names(search(repo, 'bench press'))).toEqual(['Bench Press', 'Dumbbell Bench Press', 'Incline Bench Press', 'Close-grip press']);
    expect(names(search(repo, 'bench'))).toEqual(['Bench Dips', 'Bench Press', 'Benchmark row', 'Dumbbell Bench Press', 'Incline Bench Press', 'Close-grip press']);
  });
  test('case, punctuation and a plural s don’t matter', () => {
    expect(names(search(repo, 'PUSH UP'))).toEqual(['Push-Ups', 'Knee push-ups']);
    expect(rank(ex('Push-Ups'), 'pushup')).toBe(4);
    expect(names(search(repo, '   '))).toHaveLength(8);
  });
  test('on the real library: the plain name comes first', () => {
    for (const q of ['Bench Press', 'Plank', 'Pull-ups', 'Deadlifts', 'Squats']) expect(search(exercises, q)[0].name).toBe(q);
    expect(search(exercises, 'walking lunges')[0].name).toBe('Dumbbell Lunges Walking'); // its alias
  });
  test('no match: the closest rows share a query word', () => {
    expect(search(exercises, 'nordic curl')).toEqual([]);
    const c = closest(exercises, 'nordic curl');
    expect(c.length).toBeGreaterThan(0);
    for (const e of c) expect(words(e.name).some((w) => w.startsWith('curl'))).toBe(true);
  });
});

describe('filters', () => {
  test('muscle chip and Equipment combine; the results line names them', () => {
    const f = { group: 'Back' as const, equipment: 'Cable' };
    const r = search(exercises, '', f);
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((e) => e.group === 'Back' && e.equipment === 'Cable')).toBe(true);
    expect(r.length).toBe(ALL.filter((e) => e.group === 'Back' && e.equipment === 'Cable').length);
    expect(resultsLine(r.length, f)).toBe(`${r.length} exercises · Back · Cable`);
    expect(resultsLine(1, { group: 'All', equipment: 'Band' })).toBe('1 exercise · Band');
    // search inside the filters
    expect(search(exercises, 'row', f).every((e) => e.group === 'Back' && e.equipment === 'Cable')).toBe(true);
  });
  test('the chips and the Equipment list cover every row', () => {
    expect(ALL.every((e) => ['Chest', 'Back', 'Legs', 'Shoulders', 'Arms', 'Core', 'Full body'].includes(e.group))).toBe(true);
    const eq = equipmentOf(exercises);
    expect(eq.slice(0, 3)).toEqual(['Barbell', 'Dumbbell', 'Cable']);
    expect(ALL.every((e) => eq.includes(e.equipment))).toBe(true);
    expect(search(exercises, '', NO_FILTERS)).toHaveLength(ALL.length);
  });
});

test('credit line (§9.3): licence and author, "and N others", none for CC0', () => {
  expect(creditLine(ex('X', { licence_authors: ['Ann'] }))).toBe('Steps adapted from wger.de (author: Ann), CC BY-SA 4.0');
  expect(creditLine(ex('X', { licence: 'CC-BY-SA-3.0', licence_authors: ['Ann', 'Bo', 'Cy', 'Di'] }))).toBe('Steps adapted from wger.de (author: Ann and 3 others), CC BY-SA 3.0');
  expect(creditLine(ex('X', { licence_authors: ['Ann', 'Bo'] }))).toContain('Ann and 1 other)');
  expect(creditLine(ex('X', { licence: 'CC0-1.0' }))).toBeNull();
});

test('architecture: the exercise table is read only through the data layer (src/lib/exercises.ts)', () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(p) ? [p] : []; });
  const users = walk(join(__dirname, '../src')).filter((p) => /exercises\.json/.test(readFileSync(p, 'utf8')));
  expect(users.map((p) => p.split('src')[1])).toEqual([join('/lib', 'exercises.ts')]);
});

// ---------- screens ----------
async function mount(ui: React.ReactElement) {
  let r!: ReactTestRenderer;
  await act(async () => { r = create(<StoreProvider>{ui}</StoreProvider>); });
  await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
  return r;
}
const byLabel = (r: ReactTestRenderer, l: string | RegExp) => r.root.findAll((x) => typeof x.props.onPress === 'function' && (typeof l === 'string' ? x.props.accessibilityLabel === l : l.test(String(x.props.accessibilityLabel ?? ''))));
const press = (r: ReactTestRenderer, l: string | RegExp) => { const m = byLabel(r, l); if (!m.length) throw new Error(`no ${l}`); return act(async () => { m[0].props.onPress(); }); };
const texts = (r: ReactTestRenderer) => r.root.findAll((x) => typeof x.type === 'string').flatMap((x) => [x.props.children].flat()).filter((c) => typeof c === 'string').join('|');

test('list: hint card, Back + Cable filters with Clear filters, a no-result search with the closest rows, tap opens the how-to', async () => {
  mockSaved = null;
  const r = await mount(<LibraryScreen />);
  expect(texts(r)).toContain('Tap any exercise for a how-to.');
  expect(texts(r)).toContain('All exercises');
  await press(r, 'Muscle: Back');
  await press(r, /^Equipment: any/);
  await press(r, 'Cable');
  const n = ALL.filter((e) => e.group === 'Back' && e.equipment === 'Cable').length;
  expect(texts(r)).toContain(`${n} exercises`);
  expect(texts(r)).toContain(' · Back · Cable');
  await press(r, 'Clear filters');
  expect(texts(r)).not.toContain(' · Back · Cable');
  await act(async () => { r.root.findAll((x) => x.type === TextInput)[0].props.onChangeText('nordic curl'); });
  expect(texts(r)).toContain('No match for “|nordic curl|”');
  expect(texts(r)).toContain('Closest in the library');
  await press(r, /curl.*How-to$/i);
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/train/exercise/[id]', params: { id: expect.stringMatching(/^wger-\d+$/) } });
  await press(r, 'Clear search');
  await press(r, 'Dismiss hint');
  expect(texts(r)).not.toContain('Tap any exercise for a how-to.');
  expect(JSON.parse(mockSaved!).libraryHintDone).toBe(true); // stays dismissed after a restart
  await act(async () => { r.unmount(); });
});

test('how-to page: placeholder demo slot (no media), muscles, the source’s steps, credit line', async () => {
  const e = search(exercises, 'Bench press')[0];
  const r = await mount(<ExerciseScreen id={e.id} />);
  const t = texts(r);
  expect(t).toContain('Demo coming soon');
  expect(t).toContain('We’re drawing this one. Steps and muscles are below.');
  expect(r.root.findAll((x) => x.props.testID === 'demo-slot' && typeof x.type === 'string')).toHaveLength(1);
  expect(t).toContain('Main muscle');
  expect(r.root.findAll((x) => ['Image', 'RCTImageView'].includes(String(x.type)))).toHaveLength(0);
  for (const s of e.steps) expect(t).toContain(s);
  expect(t).toContain(e.primary_muscles[0]);
  expect(t).toContain(creditLine(e)!);
  expect(t).toContain(`${e.group} · ${e.equipment}`);
  await act(async () => { r.unmount(); });
});

test('credits (§9.6): wger contributors with every named author, our table, no media entries', async () => {
  const r = await mount(<CreditsScreen />);
  expect(texts(r)).toContain('wger.de contributors');
  expect(texts(r)).toContain('Our exercise table');
  expect(texts(r)).not.toMatch(/body-highlighter|YouTube/i);
  await press(r, /^All authors/);
  const t = texts(r);
  const named = new Set(exercises.all().flatMap((e) => e.licence_authors));
  expect(allAuthors(exercises)).toHaveLength(named.size);
  for (const a of named) expect(t).toContain(a);
  await act(async () => { r.unmount(); });
});
