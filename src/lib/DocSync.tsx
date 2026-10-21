// M4: keeps plans, finished workouts, habits and habit logs in step with the server, through the one API client and the
// store's offline queue. Off (renders nothing, does nothing) unless the build has a backend (EXPO_PUBLIC_API_URL) and the
// user is signed in, so a build without one behaves exactly as before. On sign-in it pulls the server's rows once, then
// every change on the phone is queued (the body that changed, or a delete); what the server answers lands back here.
import { useEffect, useRef, useState } from 'react';
import { bodies, diff, landPull, landResult, type Landing, type Local } from './docRows';
import { exercises, type ExerciseRepo } from './exercises';
import { useHabits } from './habits';
import { usePlans } from './plans';
import { useStore } from './store';
import { useWorkouts } from './workouts';

export function DocSync({ repo = exercises }: { repo?: ExerciseRepo }) {
  const st = useStore(), pl = usePlans(), wo = useWorkouts(), hb = useHabits();
  const on = st.docSyncOn && pl.ready && wo.ready && hb.ready;
  const local: Local = { plans: pl.state, workouts: wo.state, habits: hb.state };
  const localRef = useRef(local); localRef.current = local;
  const live = useRef({ st, pl, wo, hb }); live.current = { st, pl, wo, hb };
  const land = (l: Landing) => {
    const { st: s, pl: p, wo: w, hb: h } = live.current, cur = localRef.current;
    s.adoptDocs(l.adopt, l.forget); // the ledger first: the state change below then has nothing new to send
    if (l.local.plans !== cur.plans) p.applyServer(() => l.local.plans);
    if (l.local.workouts !== cur.workouts) w.applyServer(() => l.local.workouts);
    if (l.local.habits !== cur.habits) h.applyServer(() => l.local.habits);
    localRef.current = l.local;
    if (l.notices.length) s.showNotice(l.notices.join('\n'));
  };
  const landRef = useRef(land); landRef.current = land;
  // answers to queued docs (409: the server's row; refused: the reason; deleted elsewhere: gone)
  useEffect(() => st.onDocResult((r) => landRef.current(landResult(localRef.current, r, repo))), []); // eslint-disable-line react-hooks/exhaustive-deps

  // once per signed-in user and app run: pull the server's rows before sending anything (a new phone gets its data)
  const uid = st.user?.id ?? null;
  const [pulled, setPulled] = useState<string | null>(null);
  useEffect(() => {
    if (!on || !uid || pulled === uid) return;
    let live = true;
    st.api.listDocs()
      .then((rows) => { if (live) landRef.current(landPull(localRef.current, { plan: rows.plans, workout: rows.workouts, habit: rows.habits, habitLog: rows.logs },
        st.docLedger(), new Set(st.queue.flatMap((o) => (o.kind === 'doc' ? [o.id] : []))), repo)); })
      .catch(() => { /* offline: the changes below still queue; the pull runs again next app start */ })
      .finally(() => { if (live) setPulled(uid); });
    return () => { live = false; };
  }, [on, uid, pulled]); // eslint-disable-line react-hooks/exhaustive-deps

  // every change: queue what differs from what was last queued
  useEffect(() => {
    if (!on || pulled !== uid) return;
    st.queueDocs(diff(bodies(local, repo), st.docLedger().sent));
  }, [on, pulled, uid, pl.state, wo.state, hb.state]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
