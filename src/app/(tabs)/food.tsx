import { TimelineScreen } from '@/features/timeline/TimelineScreen';

/** Food tab: the day timeline (build-plan item 6, spec §4). The old Today screen is retired from navigation; its code
 * (src/features/today) stays for the tests that still render it. */
export default function Food() {
  return <TimelineScreen />;
}
