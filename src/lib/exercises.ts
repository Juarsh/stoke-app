// Exercise library data layer (spec §9.7, §12.6, architecture rule): the app reads exercises only through ExerciseRepo.
// Today's implementation is the bundled one-off curated wger export (src/data/exercises.json, built by
// tools/wger/curate.mjs); a server-backed table later is a new implementation of the same interface.
import data from '../data/exercises.json';

export type ExerciseGroup = 'Chest' | 'Back' | 'Legs' | 'Shoulders' | 'Arms' | 'Core' | 'Full body';
export type ExerciseType = 'weight_reps' | 'bodyweight' | 'time' | 'distance';
export interface Exercise {
  id: string; name: string; aliases: string[];
  group: ExerciseGroup; equipment: string;
  primary_muscles: string[]; secondary_muscles: string[];
  type: ExerciseType;
  /** how-to steps from the source (adapted: split into steps, HTML removed) */
  steps: string[];
  source: 'wger'; source_ref: string; wger_id: number; wger_translation_id: number;
  /** licence of the steps text and its authors (the credit line), and of the exercise data */
  licence: 'CC-BY-SA-4.0' | 'CC-BY-SA-3.0' | 'CC0-1.0'; licence_url: string; licence_authors: string[];
  data_licence: string; data_licence_author: string;
  adapted: boolean; art_origin: string | null; video_url: string | null; video_channel: string | null;
}
export interface ExerciseRepo {
  all(): readonly Exercise[];
  byId(id: string): Exercise | undefined;
  /** where the rows come from, for Credits */
  source: { name: string; fetchedAt: string };
}
export function bundledExercises(rows: readonly Exercise[], source = { name: 'wger.de', fetchedAt: '' }): ExerciseRepo {
  const byId = new Map(rows.map((e) => [e.id, e]));
  return { all: () => rows, byId: (id) => byId.get(id), source };
}
export const exercises: ExerciseRepo = bundledExercises(data.rows as Exercise[], { name: data.source, fetchedAt: data.fetched_at });
