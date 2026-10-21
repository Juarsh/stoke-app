// P1.1 fixes from Tester's P1 report (p1-92ec625): B1 Health Connect on in release and never prompting by itself,
// O1 "Last:" by eaten-at, O2 toasts (48dp, a touch restarts 4 s, stay with a screen reader), O4 (4 AM date line and
// rollover, 48dp tray ✕, edited flags kept on a timeline edit, no SYSTEM_ALERT_WINDOW).
import React from 'react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { AccessibilityInfo } from 'react-native';

jest.mock('../src/lib/config', () => ({ config: { mock: true, mockAi: false, mockAiDelay: 0 }, flags: { steps: true, healthConnect: true } }));

import { dayOf, FoodEntry } from '../src/lib/domain';
import { msToNextDay } from '../src/lib/useLogDay';
import { homeDate, lastLine } from '../src/features/home/model';
import { DISHES } from '../src/parser';
import { buildEntries, compute, newTrayItem, resetEdits } from '../src/features/logfood/model';
import { entryFromEdit, trayFromEntry } from '../src/features/timeline/model';
import { Toast } from '../src/components/Toast';

const root = join(__dirname, '..');
const src = (p: string) => readFileSync(join(root, p), 'utf8');

describe('B1: Health Connect in the release build', () => {
  test('the release build script sets the flag; app.config reads it; Expo Go / web leave it off', () => {
    expect(src('tools/build-apk.sh')).toMatch(/EXPO_PUBLIC_FLAG_HEALTH_CONNECT=1/);
    expect(src('tools/build-apk.sh')).toMatch(/"healthConnect":true/); // the script checks the built APK
    expect(src('app.config.ts')).toMatch(/healthConnect: env\.EXPO_PUBLIC_FLAG_HEALTH_CONNECT === '1'/);
  });
  test('nothing asks for permission by itself: only connectSteps() requests it, and only the sheet’s Connect calls that', () => {
    // since the HealthKit change the prompt lives in each adapter's connect(); health.ts only routes connectSteps() to it
    const health = src('src/lib/health.ts');
    const status = health.slice(health.indexOf('export async function stepsStatus'), health.indexOf('export async function connectSteps'));
    expect(status).not.toMatch(/connect\(\)/);
    expect(health.match(/\.connect\(\)/g)).toHaveLength(1);
    expect(health.slice(health.indexOf('export async function connectSteps'), health.indexOf('export const getHealthApp'))).toMatch(/\.connect\(\)/);
    const hc = src('src/lib/healthConnect.ts');
    expect(hc.match(/requestPermission\(/g)).toHaveLength(1);
    expect(hc.slice(hc.indexOf('async connect()'), hc.indexOf('async steps('))).toMatch(/requestPermission\(/);
    const home = src('src/app/(tabs)/index.tsx');
    // connectSteps is only reached from the sheet's button
    expect(home.match(/connectSteps\(\)/g)).toHaveLength(1);
    expect(home).toMatch(/onPress=\{async \(\) => \{ if \(missing\)[^\n]*connectSteps\(\)/);
  });
  test('SYSTEM_ALERT_WINDOW is blocked in app.config (removed from the merged manifest)', () => {
    expect(src('app.config.ts')).toMatch(/blockedPermissions: \['android\.permission\.SYSTEM_ALERT_WINDOW'\]/);
  });
});

const TODAY = '2026-10-21';
const NOW = new Date('2026-10-21T14:00:00Z');
const dish = (name: string) => DISHES.find((d) => d.name.toLowerCase() === name)!;
let n = 0;
const row = (name: string, eaten: string, created: string): FoodEntry => {
  const e = buildEntries([newTrayItem(dish(name), 'k')], new Date(eaten), { now: NOW, newId: () => `e${++n}` }).entries[0];
  return { ...e, created_at: created, eaten_at: new Date(eaten).toISOString() };
};

describe('O1: Last line by eaten-at', () => {
  test('logged at 2 PM for 1 PM reads 1:00 PM', () => {
    expect(lastLine([row('roti', `${TODAY}T13:00:00+05:30`, `${TODAY}T08:30:00Z`)])).toMatch(/^Last: 1:00 PM · /);
  });
  test('a breakfast logged later does not become the last meal', () => {
    const lunch = row('roti', `${TODAY}T13:00:00+05:30`, `${TODAY}T07:30:00Z`);
    const poha = row('poha', `${TODAY}T08:00:00+05:30`, `${TODAY}T08:30:00Z`);
    const line = lastLine([lunch, poha])!;
    expect(line).toMatch(/^Last: 1:00 PM · /);
    expect(line.toLowerCase()).not.toContain('poha');
  });
});

describe('O2: toasts', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const mount = async (onClose: jest.Mock) => {
    let r!: ReactTestRenderer;
    const cur = { id: 1 };
    await act(async () => { r = create(<Toast current={cur} text="Removed Dal" action={{ label: 'Undo', onPress: jest.fn() }} onClose={onClose} style={{}} textColor="#000" actionColor="#000" />); });
    return r;
  };
  test('Undo is 48dp; closes after 4 s; a touch at 3 s restarts the 4 s', async () => {
    const onClose = jest.fn();
    const r = await mount(onClose);
    const undo = r.root.findAll((x) => x.props.accessibilityLabel === 'Undo' && typeof x.props.onPress === 'function')[0];
    expect(undo.props.style.minHeight).toBeGreaterThanOrEqual(48);
    await act(async () => { jest.advanceTimersByTime(3000); });
    await act(async () => { r.root.findAll((x) => x.props.testID === 'toast' && x.props.onTouchStart)[0].props.onTouchStart(); });
    await act(async () => { jest.advanceTimersByTime(3500); });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { jest.advanceTimersByTime(600); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  test('with a screen reader on it stays until dismissed, with a 48dp Dismiss', async () => {
    const spy = jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockResolvedValue(true);
    const onClose = jest.fn();
    const r = await mount(onClose);
    await act(async () => { jest.advanceTimersByTime(60_000); });
    expect(onClose).not.toHaveBeenCalled();
    const dismiss = r.root.findAll((x) => x.props.accessibilityLabel === 'Dismiss' && typeof x.props.onPress === 'function')[0];
    expect(dismiss.props.style.minHeight).toBeGreaterThanOrEqual(48);
    await act(async () => { dismiss.props.onPress(); });
    expect(onClose).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
  test('every screen toast uses the shared Toast (no fixed setTimeout left)', () => {
    for (const f of ['src/features/logfood/LogFoodScreen.tsx', 'src/features/myfoods/MyFoodsScreen.tsx', 'src/components/NoticeToast.tsx']) {
      expect(src(f)).toMatch(/<Toast /);
      expect(src(f)).not.toMatch(/setTimeout\(\(\) => setToast\(null\)/);
    }
  });
});

describe('O4', () => {
  test('00:00–03:59 belongs to the previous day: Home date line and the 04:00 rollover', () => {
    const late = new Date('2026-10-22T02:30:00+05:30');
    expect(dayOf(late)).toBe(TODAY);
    expect(homeDate(dayOf(late))).toBe('Wednesday 21 Oct');
    expect(msToNextDay(late)).toBe(90 * 60_000); // next re-render at 4:00 AM
    expect(msToNextDay(new Date('2026-10-22T04:00:00+05:30'))).toBe(24 * 3600_000);
  });
  test('tray ✕ is 48dp', () => {
    expect(src('src/features/logfood/LogFoodScreen.tsx')).toMatch(/accessibilityLabel=\{`Remove \$\{c\.name\}`\} style=\{\{ width: 48, height: 48/);
  });
  test('a timeline edit keeps the edited flag (the sheet opens with the edited pill)', () => {
    const t = newTrayItem(dish('roti'), 'k');
    const own = compute(t).kcal;
    const e = { ...buildEntries([{ ...t, kcalPerG: (own + 40) / compute(t).grams }], new Date(`${TODAY}T13:00:00+05:30`), { now: NOW, newId: () => 'r1' }).entries[0], server_version: 1 };
    expect(e.kcal_edited).toBe(true);
    const back = trayFromEntry(e);
    expect(compute(back)).toMatchObject({ kcalEdited: true, kcal: own + 40 });
    // change only the time: still edited
    const moved = entryFromEdit(e, back, new Date(`${TODAY}T12:00:00+05:30`), NOW).entry!;
    expect(moved.kcal_edited).toBe(true);
    expect(moved.kcal.best).toBe(own + 40);
    // an amount change scales the typed value and keeps the flag
    const more = entryFromEdit(e, { ...back, amount: back.amount * 2 }, new Date(`${TODAY}T13:00:00+05:30`), NOW).entry!;
    expect(more.kcal_edited).toBe(true);
    expect(more.kcal.best).toBe((own + 40) * 2);
    void resetEdits;
  });
});
