// P1 item 2: onboarding targets, field validation, and offline save through the LocalStore data layer (sex stays on the phone).
import React from 'react';
import { act, create } from 'react-test-renderer';

jest.mock('../src/lib/config', () => ({ config: { mock: true, apiUrl: '', mockAi: false }, flags: {} }));
let mockSaved: string | null = null;
jest.mock('../src/lib/kv', () => ({ kv: { get: async () => mockSaved, set: async (_k: string, v: string) => { mockSaved = v; } } }));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'uuid' }));

import { computeTargets, fieldNumber, MIN_KCAL, Profile, PROFILE_LIMITS, profileFieldErrors, profilePayload } from '../src/lib/domain';
import { StoreProvider, useStore } from '../src/lib/store';

describe('daily targets (Mifflin-St Jeor × activity, goal adjust, guard rails)', () => {
  // male, 30 y, 175 cm, 75 kg: BMR = 750 + 1093.75 - 150 + 5 = 1698.75
  const p = { sex: 'm' as const, age: 30, heightCm: 175, weightKg: 75 };
  test.each([
    ['maintain', 'moderate', 2630, 90, 2633], // 1698.75 × 1.55 = 2633.06 -> 2630; 75 × 1.2
    ['lose', 'moderate', 2230, 120, 2633],    // -400; 75 × 1.6
    ['gain', 'active', 3230, 120, 2930],      // 1698.75 × 1.725 = 2930.34 + 300 -> 3230
    ['maintain', 'light', 2340, 90, 2336],    // × 1.375 = 2335.78 -> 2340
  ] as const)('%s / %s -> %d kcal, %d g protein', (goal, activity, kcal, protein, maintenance) => {
    expect(computeTargets({ ...p, goal, activity })).toEqual({ kcal, protein, maintenance });
  });
  test('floor: a small, older person losing weight gets 1,200', () => {
    expect(computeTargets({ goal: 'lose', sex: 'f', age: 100, heightCm: 100, weightKg: 25, activity: 'sedentary' }).kcal).toBe(MIN_KCAL);
  });
  test('every in-range profile: target >= 1,200, at most 500 under maintenance, protein > 0', () => {
    for (const age of [13, 50, 100]) for (const heightCm of [100, 175, 250]) for (const weightKg of [25, 80, 300])
      for (const goal of ['lose', 'maintain', 'gain'] as const) for (const sex of ['m', 'f', 'x'] as const) {
        const r = computeTargets({ goal, sex, age, heightCm, weightKg, activity: 'moderate' });
        expect(r.kcal).toBeGreaterThanOrEqual(MIN_KCAL);
        if (r.kcal > MIN_KCAL) expect(r.maintenance - r.kcal).toBeLessThanOrEqual(500);
        expect(r.protein).toBeGreaterThan(0);
      }
  });
});

describe('field validation (same ranges as the server profile check)', () => {
  const ok = { age: '30', heightCm: '175', weightKg: '75' };
  test('limits match goals.go', () => expect(PROFILE_LIMITS).toEqual({ age: [13, 100], heightCm: [100, 250], weightKg: [25, 300] }));
  test('valid values: no errors', () => expect(profileFieldErrors(ok)).toEqual({}));
  test('edges are allowed', () => {
    expect(profileFieldErrors({ age: '13', heightCm: '100', weightKg: '25' })).toEqual({});
    expect(profileFieldErrors({ age: '100', heightCm: '250', weightKg: '300' })).toEqual({});
  });
  test.each([
    ['age', '12', 'Enter an age from 13 to 100.'], ['age', '101', 'Enter an age from 13 to 100.'], ['age', '', 'Enter an age from 13 to 100.'],
    ['heightCm', '99', 'Enter a height from 100 to 250 cm.'], ['heightCm', '251', 'Enter a height from 100 to 250 cm.'],
    ['weightKg', '24', 'Enter a weight from 25 to 300 kg.'], ['weightKg', '0', 'Enter a weight from 25 to 300 kg.'], ['weightKg', '', 'Enter a weight from 25 to 300 kg.'],
  ] as const)('%s = "%s" -> error', (k, v, msg) => {
    expect(profileFieldErrors({ ...ok, [k]: v })).toEqual({ [k]: msg });
  });
  test('empty or non-numeric text is never turned into a default', () => {
    expect(fieldNumber('')).toBeNull(); expect(fieldNumber('7a')).toBeNull(); expect(fieldNumber(' 70 ')).toBe(70);
  });
});

describe('save on the phone (offline, no backend)', () => {
  test('setProfile persists through LocalStore; sex is kept locally but never in the server payload', async () => {
    mockSaved = null;
    let st!: ReturnType<typeof useStore>;
    const Probe = () => { st = useStore(); return null; };
    await act(async () => { create(<StoreProvider><Probe /></StoreProvider>); });
    const tgt = computeTargets({ goal: 'lose', sex: 'f', age: 28, heightCm: 160, weightKg: 62, activity: 'light' });
    const profile: Profile = { goal: 'lose', sex: 'f', age: 28, heightCm: 160, weightKg: 62, activity: 'light', diet: 'veg',
      kcalTarget: tgt.kcal, proteinTarget: tgt.protein, maintenanceKcal: tgt.maintenance, stepsTarget: 8000, addStepKcal: false, showKcalOnCards: true };
    await act(async () => { st.setProfile(profile); });
    const saved = JSON.parse(mockSaved ?? '{}');
    expect(saved.profile).toMatchObject({ sex: 'f', kcalTarget: tgt.kcal, proteinTarget: tgt.protein });
    expect(JSON.stringify(profilePayload(profile))).not.toMatch(/"sex"/);
    expect(JSON.stringify(saved.queue)).not.toMatch(/"sex"/);
  });
});
