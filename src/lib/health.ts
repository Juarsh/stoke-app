// Health Connect steps, behind flags.healthConnect (needs a dev build; not in Expo Go).
import { Platform } from 'react-native';
import { flags } from './config';

export async function readTodaySteps(): Promise<number | null> {
  if (!flags.steps || !flags.healthConnect || Platform.OS !== 'android') return null;
  try {
    const hc = await import('react-native-health-connect');
    if (!(await hc.initialize())) return null;
    const granted = await hc.requestPermission([{ accessType: 'read', recordType: 'Steps' }]);
    if (!granted.some((g) => 'recordType' in g && g.recordType === 'Steps')) return null;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const r = await hc.readRecords('Steps', { timeRangeFilter: { operator: 'between', startTime: start.toISOString(), endTime: new Date().toISOString() } });
    return r.records.reduce((s, x) => s + x.count, 0);
  } catch {
    return null;
  }
}
