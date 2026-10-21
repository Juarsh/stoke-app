package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type querier interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// decide what a write based on version `ver` does to a stored row: nothing (same content: a replay), write it, or a
// conflict. ownCreate: ids are made on the phone, so a stored version 1 can only be the sender's own create (another
// device's edit makes it 2+); a version-less write may then go on (its create's answer was lost).
func decide(cur int, same bool, ver *int, ownCreate bool) (write, conflict bool) {
	switch {
	case same:
		return false, false
	case ver == nil:
		return ownCreate && cur == 1, !(ownCreate && cur == 1)
	case *ver == cur:
		return true, false
	default:
		return false, true
	}
}

// sameJSON compares two values by their JSON (content only: callers clear version and timestamps first).
func sameJSON(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}

func utc(t time.Time) time.Time { return t.UTC().Truncate(time.Microsecond) }
func utcp(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	u := utc(*t)
	return &u
}

func inTx(ctx context.Context, s *PG, f func(tx pgx.Tx) error) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := f(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ---- users / identities ----------------------------------------------------------------------------------------

// Resolve: the identity's user id; on first sign-in a user row (users.google_sub keeps the subject, as before M4,
// so older rows and code still match) and the identity row.
func (s *PG) Resolve(ctx context.Context, provider, subject, email, name string) (int64, error) {
	var uid int64
	err := inTx(ctx, s, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx, `SELECT user_id FROM user_identities WHERE provider=$1 AND subject=$2`, provider, subject).Scan(&uid)
		if err == nil {
			_, err = tx.Exec(ctx, `UPDATE users SET email=$2 WHERE id=$1 AND email<>$2`, uid, email)
			return err
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if err := tx.QueryRow(ctx, `INSERT INTO users(google_sub,email,name) VALUES ($1,$2,$3)
			ON CONFLICT (google_sub) DO UPDATE SET email=EXCLUDED.email RETURNING id`, subject, email, name).Scan(&uid); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO user_identities(provider,subject,user_id,email) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, provider, subject, uid, email)
		return err
	})
	return uid, err
}

// ---- plans + routines ------------------------------------------------------------------------------------------

func getPlan(ctx context.Context, q querier, uid int64, id string, lock bool) (Plan, error) {
	sql := `SELECT id,name,days,active,version,created_at,updated_at,deleted_at FROM plans WHERE user_id=$1 AND id=$2`
	if lock {
		sql += ` FOR UPDATE`
	}
	var p Plan
	if err := q.QueryRow(ctx, sql, uid, id).Scan(&p.ID, &p.Name, &p.Days, &p.Active, &p.Version, &p.CreatedAt, &p.UpdatedAt, &p.DeletedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Plan{}, ErrNotFound
		}
		return Plan{}, err
	}
	rows, err := q.Query(ctx, `SELECT id,name,exercises FROM routines WHERE user_id=$1 AND plan_id=$2 ORDER BY position`, uid, id)
	if err != nil {
		return Plan{}, err
	}
	defer rows.Close()
	p.Routines = []Routine{}
	for rows.Next() {
		var r Routine
		var ex []byte
		if err := rows.Scan(&r.ID, &r.Name, &ex); err != nil {
			return Plan{}, err
		}
		if err := json.Unmarshal(ex, &r.Exercises); err != nil {
			return Plan{}, err
		}
		p.Routines = append(p.Routines, r)
	}
	p.CreatedAt, p.UpdatedAt, p.DeletedAt = utc(p.CreatedAt), utc(p.UpdatedAt), utcp(p.DeletedAt)
	return p, rows.Err()
}

func planContent(p Plan) Plan {
	return Plan{ID: p.ID, Name: p.Name, Days: p.Days, Active: p.Active, Routines: p.Routines}
}

func (s *PG) GetPlan(ctx context.Context, uid int64, id string) (Plan, error) {
	return getPlan(ctx, s.DB, uid, id, false)
}

func (s *PG) ListPlans(ctx context.Context, uid int64) ([]Plan, error) {
	ids, err := listIDs(ctx, s.DB, `SELECT id FROM plans WHERE user_id=$1 AND deleted_at IS NULL ORDER BY created_at, id`, uid)
	if err != nil {
		return nil, err
	}
	out := []Plan{}
	for _, id := range ids {
		p, err := getPlan(ctx, s.DB, uid, id, false)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, nil
}

func listIDs(ctx context.Context, q querier, sql string, args ...any) ([]string, error) {
	rows, err := q.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

func writeRoutines(ctx context.Context, tx pgx.Tx, uid int64, p Plan) error {
	if _, err := tx.Exec(ctx, `DELETE FROM routines WHERE user_id=$1 AND plan_id=$2`, uid, p.ID); err != nil {
		return err
	}
	for i, r := range p.Routines {
		ex, _ := json.Marshal(r.Exercises)
		if _, err := tx.Exec(ctx, `INSERT INTO routines(id,user_id,plan_id,position,name,exercises) VALUES ($1,$2,$3,$4,$5,$6)`, r.ID, uid, p.ID, i, r.Name, ex); err != nil {
			return err
		}
	}
	return nil
}

func (s *PG) PutPlan(ctx context.Context, uid int64, in Plan, ver *int) (Plan, error) {
	var out Plan
	err := inTx(ctx, s, func(tx pgx.Tx) error {
		cur, err := getPlan(ctx, tx, uid, in.ID, true)
		switch {
		case errors.Is(err, ErrNotFound):
			if _, err := tx.Exec(ctx, `INSERT INTO plans(id,user_id,name,days,active) VALUES ($1,$2,$3,$4,$5)`, in.ID, uid, in.Name, in.Days, in.Active); err != nil {
				return err
			}
		case err != nil:
			return err
		case cur.DeletedAt != nil:
			return ErrGone
		default:
			write, conflict := decide(cur.Version, sameJSON(planContent(cur), planContent(in)), ver, true)
			if conflict {
				return &Conflict{Current: cur, Version: cur.Version}
			}
			if !write {
				out = cur
				return nil
			}
			if _, err := tx.Exec(ctx, `UPDATE plans SET name=$3, days=$4, active=$5 WHERE user_id=$1 AND id=$2`, uid, in.ID, in.Name, in.Days, in.Active); err != nil {
				return err
			}
		}
		if err := writeRoutines(ctx, tx, uid, in); err != nil {
			return err
		}
		out, err = getPlan(ctx, tx, uid, in.ID, false)
		return err
	})
	return out, err
}

// softDelete: the delete rule for every synced row (a stale version is a conflict; already deleted is done).
func softDelete[T any](ctx context.Context, s *PG, get func(q querier) (T, int, *time.Time, error), del func(q querier) error, ver *int, ownCreate bool) error {
	return inTx(ctx, s, func(tx pgx.Tx) error {
		cur, v, deleted, err := get(tx)
		if err != nil {
			return err
		}
		if deleted != nil {
			return nil
		}
		if _, conflict := decide(v, false, ver, ownCreate); conflict {
			return &Conflict{Current: cur, Version: v}
		}
		return del(tx)
	})
}

func (s *PG) DeletePlan(ctx context.Context, uid int64, id string, ver *int) error {
	return softDelete(ctx, s, func(q querier) (Plan, int, *time.Time, error) {
		p, err := getPlan(ctx, q, uid, id, true)
		return p, p.Version, p.DeletedAt, err
	}, func(q querier) error {
		_, err := q.Exec(ctx, `UPDATE plans SET deleted_at=now() WHERE user_id=$1 AND id=$2`, uid, id)
		return err
	}, ver, true)
}

// ---- workouts + sets -------------------------------------------------------------------------------------------

func getWorkout(ctx context.Context, q querier, uid int64, id string, lock bool) (Workout, error) {
	sql := `SELECT id,title,plan_id,routine_id,local_date::text,started_at,ended_at,version,created_at,updated_at,deleted_at FROM workouts WHERE user_id=$1 AND id=$2`
	if lock {
		sql += ` FOR UPDATE`
	}
	var w Workout
	if err := q.QueryRow(ctx, sql, uid, id).Scan(&w.ID, &w.Title, &w.PlanID, &w.RoutineID, &w.LocalDate, &w.StartedAt, &w.EndedAt, &w.Version, &w.CreatedAt, &w.UpdatedAt, &w.DeletedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Workout{}, ErrNotFound
		}
		return Workout{}, err
	}
	w.StartedAt, w.EndedAt, w.CreatedAt, w.UpdatedAt, w.DeletedAt = utc(w.StartedAt), utc(w.EndedAt), utc(w.CreatedAt), utc(w.UpdatedAt), utcp(w.DeletedAt)
	rows, err := q.Query(ctx, `SELECT ex_id,exercise_id,kind,rest_s,target FROM workout_exercises WHERE user_id=$1 AND workout_id=$2 ORDER BY position`, uid, id)
	if err != nil {
		return Workout{}, err
	}
	w.Exercises = []WorkoutExercise{}
	for rows.Next() {
		var e WorkoutExercise
		var tg []byte
		if err := rows.Scan(&e.ID, &e.ExerciseID, &e.Kind, &e.RestS, &tg); err != nil {
			rows.Close()
			return Workout{}, err
		}
		if len(tg) > 0 && string(tg) != "null" {
			e.Target = &Target{}
			_ = json.Unmarshal(tg, e.Target)
		}
		e.Sets = []WSet{}
		w.Exercises = append(w.Exercises, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return Workout{}, err
	}
	srows, err := q.Query(ctx, `SELECT ex_position,set_id,done,kg::float8,reps,done_at FROM workout_sets WHERE user_id=$1 AND workout_id=$2 ORDER BY ex_position, position`, uid, id)
	if err != nil {
		return Workout{}, err
	}
	defer srows.Close()
	for srows.Next() {
		var i int
		var st WSet
		if err := srows.Scan(&i, &st.ID, &st.Done, &st.Kg, &st.Reps, &st.DoneAt); err != nil {
			return Workout{}, err
		}
		st.DoneAt = utcp(st.DoneAt)
		if i >= 0 && i < len(w.Exercises) {
			w.Exercises[i].Sets = append(w.Exercises[i].Sets, st)
		}
	}
	return w, srows.Err()
}

func workoutContent(w Workout) Workout {
	w.StartedAt, w.EndedAt = utc(w.StartedAt), utc(w.EndedAt)
	ex := make([]WorkoutExercise, len(w.Exercises))
	for i, e := range w.Exercises {
		sets := make([]WSet, len(e.Sets))
		for j, st := range e.Sets {
			st.DoneAt = utcp(st.DoneAt)
			sets[j] = st
		}
		e.Sets = sets
		ex[i] = e
	}
	return Workout{ID: w.ID, Title: w.Title, PlanID: w.PlanID, RoutineID: w.RoutineID, LocalDate: w.LocalDate, StartedAt: w.StartedAt, EndedAt: w.EndedAt, Exercises: ex}
}

func (s *PG) GetWorkout(ctx context.Context, uid int64, id string) (Workout, error) {
	return getWorkout(ctx, s.DB, uid, id, false)
}

// ListWorkouts: the user's workouts with local_date in [from, to] (either may be "").
func (s *PG) ListWorkouts(ctx context.Context, uid int64, from, to string) ([]Workout, error) {
	ids, err := listIDs(ctx, s.DB, `SELECT id FROM workouts WHERE user_id=$1 AND deleted_at IS NULL
		AND ($2='' OR local_date >= $2::date) AND ($3='' OR local_date <= $3::date) ORDER BY started_at, id`, uid, from, to)
	if err != nil {
		return nil, err
	}
	out := []Workout{}
	for _, id := range ids {
		w, err := getWorkout(ctx, s.DB, uid, id, false)
		if err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, nil
}

func writeSets(ctx context.Context, tx pgx.Tx, uid int64, w Workout) error {
	if _, err := tx.Exec(ctx, `DELETE FROM workout_exercises WHERE user_id=$1 AND workout_id=$2`, uid, w.ID); err != nil {
		return err
	}
	for i, e := range w.Exercises {
		var tg []byte
		if e.Target != nil {
			tg, _ = json.Marshal(e.Target)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO workout_exercises(user_id,workout_id,position,ex_id,exercise_id,kind,rest_s,target) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
			uid, w.ID, i, e.ID, e.ExerciseID, e.Kind, e.RestS, tg); err != nil {
			return err
		}
		for j, st := range e.Sets {
			if _, err := tx.Exec(ctx, `INSERT INTO workout_sets(user_id,workout_id,ex_position,position,set_id,done,kg,reps,done_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
				uid, w.ID, i, j, st.ID, st.Done, st.Kg, st.Reps, st.DoneAt); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *PG) PutWorkout(ctx context.Context, uid int64, in Workout, ver *int) (Workout, error) {
	var out Workout
	err := inTx(ctx, s, func(tx pgx.Tx) error {
		cur, err := getWorkout(ctx, tx, uid, in.ID, true)
		switch {
		case errors.Is(err, ErrNotFound):
			if _, err := tx.Exec(ctx, `INSERT INTO workouts(id,user_id,title,plan_id,routine_id,local_date,started_at,ended_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
				in.ID, uid, in.Title, in.PlanID, in.RoutineID, in.LocalDate, in.StartedAt, in.EndedAt); err != nil {
				return err
			}
		case err != nil:
			return err
		case cur.DeletedAt != nil:
			return ErrGone
		default:
			write, conflict := decide(cur.Version, sameJSON(workoutContent(cur), workoutContent(in)), ver, true)
			if conflict {
				return &Conflict{Current: cur, Version: cur.Version}
			}
			if !write {
				out = cur
				return nil
			}
			if _, err := tx.Exec(ctx, `UPDATE workouts SET title=$3, plan_id=$4, routine_id=$5, local_date=$6, started_at=$7, ended_at=$8 WHERE user_id=$1 AND id=$2`,
				uid, in.ID, in.Title, in.PlanID, in.RoutineID, in.LocalDate, in.StartedAt, in.EndedAt); err != nil {
				return err
			}
		}
		if err := writeSets(ctx, tx, uid, in); err != nil {
			return err
		}
		out, err = getWorkout(ctx, tx, uid, in.ID, false)
		return err
	})
	return out, err
}

func (s *PG) DeleteWorkout(ctx context.Context, uid int64, id string, ver *int) error {
	return softDelete(ctx, s, func(q querier) (Workout, int, *time.Time, error) {
		w, err := getWorkout(ctx, q, uid, id, true)
		return w, w.Version, w.DeletedAt, err
	}, func(q querier) error {
		_, err := q.Exec(ctx, `UPDATE workouts SET deleted_at=now() WHERE user_id=$1 AND id=$2`, uid, id)
		return err
	}, ver, true)
}

// ---- habits + logs ---------------------------------------------------------------------------------------------

const habitCols = `id,name,short_name,short_name_auto,icon,kind,target_value,unit,target_sets,target_reps,schedule,weekdays,starts_on::text,position,archived_at,version,created_at,updated_at,deleted_at`

func scanHabit(r pgx.Row) (Habit, error) {
	var h Habit
	var wd int16
	err := r.Scan(&h.ID, &h.Name, &h.ShortName, &h.ShortNameAuto, &h.Icon, &h.Kind, &h.TargetValue, &h.Unit, &h.TargetSets, &h.TargetReps, &h.Schedule, &wd, &h.StartsOn, &h.Position, &h.ArchivedAt, &h.Version, &h.CreatedAt, &h.UpdatedAt, &h.DeletedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Habit{}, ErrNotFound
	}
	h.Weekdays = int(wd)
	h.ArchivedAt, h.CreatedAt, h.UpdatedAt, h.DeletedAt = utcp(h.ArchivedAt), utc(h.CreatedAt), utc(h.UpdatedAt), utcp(h.DeletedAt)
	return h, err
}

func habitContent(h Habit) Habit {
	h.ArchivedAt = utcp(h.ArchivedAt)
	h.Version, h.CreatedAt, h.UpdatedAt, h.DeletedAt = 0, time.Time{}, time.Time{}, nil
	return h
}

// ShortKey: §8.3 uniqueness key (lower case, spaces and hyphens removed), the phone's shortKey().
func ShortKey(s string) string {
	b := make([]rune, 0, len(s))
	for _, r := range s {
		if r == ' ' || r == '-' || r == '\t' {
			continue
		}
		if r >= 'A' && r <= 'Z' {
			r += 'a' - 'A'
		}
		b = append(b, r)
	}
	return string(b)
}

func isUnique(err error, constraint string) bool {
	var pe *pgconn.PgError
	return errors.As(err, &pe) && pe.Code == "23505" && pe.ConstraintName == constraint
}

func (s *PG) GetHabit(ctx context.Context, uid int64, id string) (Habit, error) {
	return scanHabit(s.DB.QueryRow(ctx, `SELECT `+habitCols+` FROM habits WHERE user_id=$1 AND id=$2`, uid, id))
}

func (s *PG) ListHabits(ctx context.Context, uid int64) ([]Habit, error) {
	rows, err := s.DB.Query(ctx, `SELECT `+habitCols+` FROM habits WHERE user_id=$1 AND deleted_at IS NULL ORDER BY position, created_at, id`, uid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Habit{}
	for rows.Next() {
		h, err := scanHabit(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

func (s *PG) PutHabit(ctx context.Context, uid int64, in Habit, ver *int) (Habit, error) {
	var out Habit
	err := inTx(ctx, s, func(tx pgx.Tx) error {
		cur, err := scanHabit(tx.QueryRow(ctx, `SELECT `+habitCols+` FROM habits WHERE user_id=$1 AND id=$2 FOR UPDATE`, uid, in.ID))
		args := []any{uid, in.ID, in.Name, in.ShortName, ShortKey(in.ShortName), in.ShortNameAuto, in.Icon, in.Kind, in.TargetValue, in.Unit, in.TargetSets, in.TargetReps, in.Schedule, in.Weekdays, in.StartsOn, in.Position, in.ArchivedAt}
		switch {
		case errors.Is(err, ErrNotFound):
			_, err = tx.Exec(ctx, `INSERT INTO habits(user_id,id,name,short_name,short_key,short_name_auto,icon,kind,target_value,unit,target_sets,target_reps,schedule,weekdays,starts_on,position,archived_at)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`, args...)
		case err != nil:
			return err
		case cur.DeletedAt != nil:
			return ErrGone
		default:
			write, conflict := decide(cur.Version, sameJSON(habitContent(cur), habitContent(in)), ver, true)
			if conflict {
				return &Conflict{Current: cur, Version: cur.Version}
			}
			if !write {
				out = cur
				return nil
			}
			_, err = tx.Exec(ctx, `UPDATE habits SET name=$3, short_name=$4, short_key=$5, short_name_auto=$6, icon=$7, kind=$8, target_value=$9, unit=$10,
				target_sets=$11, target_reps=$12, schedule=$13, weekdays=$14, starts_on=$15, position=$16, archived_at=$17 WHERE user_id=$1 AND id=$2`, args...)
		}
		if isUnique(err, "habits_short_key") {
			return ErrShortNameTaken
		}
		if err != nil {
			return err
		}
		out, err = scanHabit(tx.QueryRow(ctx, `SELECT `+habitCols+` FROM habits WHERE user_id=$1 AND id=$2`, uid, in.ID))
		return err
	})
	return out, err
}

func (s *PG) DeleteHabit(ctx context.Context, uid int64, id string, ver *int) error {
	return softDelete(ctx, s, func(q querier) (Habit, int, *time.Time, error) {
		h, err := scanHabit(q.QueryRow(ctx, `SELECT `+habitCols+` FROM habits WHERE user_id=$1 AND id=$2 FOR UPDATE`, uid, id))
		return h, h.Version, h.DeletedAt, err
	}, func(q querier) error {
		_, err := q.Exec(ctx, `UPDATE habits SET deleted_at=now() WHERE user_id=$1 AND id=$2`, uid, id)
		return err
	}, ver, true)
}

const logCols = `id,habit_id,local_date::text,value,done,target_snapshot,logged_at,version,updated_at,deleted_at`

func scanLog(r pgx.Row) (HabitLog, error) {
	var l HabitLog
	var snap []byte
	err := r.Scan(&l.ID, &l.HabitID, &l.LocalDate, &l.Value, &l.Done, &snap, &l.LoggedAt, &l.Version, &l.UpdatedAt, &l.DeletedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return HabitLog{}, ErrNotFound
	}
	l.TargetSnapshot = json.RawMessage(snap)
	l.LoggedAt, l.UpdatedAt, l.DeletedAt = utc(l.LoggedAt), utc(l.UpdatedAt), utcp(l.DeletedAt)
	return l, err
}

func logContent(l HabitLog) any {
	var snap any
	_ = json.Unmarshal(l.TargetSnapshot, &snap) // jsonb reorders keys: compare as values
	return []any{l.ID, l.HabitID, l.LocalDate, l.Value, l.Done, snap, utc(l.LoggedAt)}
}

func (s *PG) ListLogs(ctx context.Context, uid int64, from, to string) ([]HabitLog, error) {
	rows, err := s.DB.Query(ctx, `SELECT `+logCols+` FROM habit_logs WHERE user_id=$1 AND deleted_at IS NULL
		AND ($2='' OR local_date >= $2::date) AND ($3='' OR local_date <= $3::date) ORDER BY local_date, habit_id`, uid, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []HabitLog{}
	for rows.Next() {
		l, err := scanLog(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// PutLog: one log per habit and day. Two phones can both log the same day, so a version-less write over a stored log
// with other content is a conflict (no ownCreate rule). A deleted log (un-ticked) is logged again by a later write.
func (s *PG) PutLog(ctx context.Context, uid int64, in HabitLog, ver *int) (HabitLog, error) {
	var out HabitLog
	err := inTx(ctx, s, func(tx pgx.Tx) error {
		var hdel *time.Time
		if err := tx.QueryRow(ctx, `SELECT deleted_at FROM habits WHERE user_id=$1 AND id=$2`, uid, in.HabitID).Scan(&hdel); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrParentMissing
			}
			return err
		}
		if hdel != nil {
			return ErrGone
		}
		cur, err := scanLog(tx.QueryRow(ctx, `SELECT `+logCols+` FROM habit_logs WHERE user_id=$1 AND habit_id=$2 AND local_date=$3 FOR UPDATE`, uid, in.HabitID, in.LocalDate))
		switch {
		case errors.Is(err, ErrNotFound):
			_, err = tx.Exec(ctx, `INSERT INTO habit_logs(user_id,habit_id,local_date,id,value,done,target_snapshot,logged_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
				uid, in.HabitID, in.LocalDate, in.ID, in.Value, in.Done, []byte(in.TargetSnapshot), in.LoggedAt)
		case err != nil:
			return err
		default:
			if cur.DeletedAt == nil {
				write, conflict := decide(cur.Version, sameJSON(logContent(cur), logContent(in)), ver, false)
				if conflict {
					return &Conflict{Current: cur, Version: cur.Version}
				}
				if !write {
					out = cur
					return nil
				}
			} else if ver != nil && *ver != cur.Version {
				return &Conflict{Current: cur, Version: cur.Version}
			}
			_, err = tx.Exec(ctx, `UPDATE habit_logs SET id=$4, value=$5, done=$6, target_snapshot=$7, logged_at=$8, deleted_at=NULL WHERE user_id=$1 AND habit_id=$2 AND local_date=$3`,
				uid, in.HabitID, in.LocalDate, in.ID, in.Value, in.Done, []byte(in.TargetSnapshot), in.LoggedAt)
		}
		if err != nil {
			return err
		}
		out, err = scanLog(tx.QueryRow(ctx, `SELECT `+logCols+` FROM habit_logs WHERE user_id=$1 AND habit_id=$2 AND local_date=$3`, uid, in.HabitID, in.LocalDate))
		return err
	})
	return out, err
}

func (s *PG) DeleteLog(ctx context.Context, uid int64, habitID, date string, ver *int) error {
	return softDelete(ctx, s, func(q querier) (HabitLog, int, *time.Time, error) {
		l, err := scanLog(q.QueryRow(ctx, `SELECT `+logCols+` FROM habit_logs WHERE user_id=$1 AND habit_id=$2 AND local_date=$3 FOR UPDATE`, uid, habitID, date))
		return l, l.Version, l.DeletedAt, err
	}, func(q querier) error {
		_, err := q.Exec(ctx, `UPDATE habit_logs SET deleted_at=now() WHERE user_id=$1 AND habit_id=$2 AND local_date=$3`, uid, habitID, date)
		return err
	}, ver, false)
}
