import { useLocalSearchParams } from 'expo-router';
import { RoutineScreen } from '@/features/plans/RoutineScreen';

/** /routine/<id>?plan=<planId>[&day=0..6]; id "new" starts a new routine (put on that day when day is given). */
export default function RoutineRoute() {
  const { id, plan, day } = useLocalSearchParams<{ id: string; plan: string; day?: string }>();
  return <RoutineScreen id={String(id)} planId={String(plan)} day={day !== undefined && day !== '' ? Number(day) : undefined} />;
}
