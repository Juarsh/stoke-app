// Package store is the only place Stoke's new code talks SQL (plain Postgres, nothing host-specific). Handlers see the
// repository interfaces below; PG implements them with pgx. The older food / summary / goals packages still run their
// own queries (pre-M4 code, left as it is so food behaviour cannot change).
//
// Version rule for every synced row (the same as food entries): the server's row is the truth. A write names the
// version it was based on; a write based on an older version is a *Conflict carrying the server's row, never a silent
// overwrite. A write identical to the stored row is answered with that row (a replay after a lost response).
package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	// ErrNotFound: no such row for this user.
	ErrNotFound = errors.New("not found")
	// ErrGone: the row was deleted (on another device); a later edit never brings it back.
	ErrGone = errors.New("deleted")
	// ErrShortNameTaken: another active habit has this short name (§8.3).
	ErrShortNameTaken = errors.New("short name taken")
	// ErrParentMissing: a habit log for a habit the server doesn't have.
	ErrParentMissing = errors.New("habit not found")
)

// Conflict: the write was based on an older version than the server's; Current is the server's row.
type Conflict struct {
	Current any
	Version int
}

func (c *Conflict) Error() string { return "version conflict" }

// Users maps a sign-in identity (provider + subject) to our own user id, creating the user on first sign-in.
type Users interface {
	Resolve(ctx context.Context, provider, subject, email, name string) (int64, error)
}

type Plans interface {
	ListPlans(ctx context.Context, uid int64) ([]Plan, error)
	GetPlan(ctx context.Context, uid int64, id string) (Plan, error)
	PutPlan(ctx context.Context, uid int64, p Plan, version *int) (Plan, error)
	DeletePlan(ctx context.Context, uid int64, id string, version *int) error
}

type Workouts interface {
	ListWorkouts(ctx context.Context, uid int64, from, to string) ([]Workout, error)
	GetWorkout(ctx context.Context, uid int64, id string) (Workout, error)
	PutWorkout(ctx context.Context, uid int64, w Workout, version *int) (Workout, error)
	DeleteWorkout(ctx context.Context, uid int64, id string, version *int) error
}

type Habits interface {
	ListHabits(ctx context.Context, uid int64) ([]Habit, error)
	GetHabit(ctx context.Context, uid int64, id string) (Habit, error)
	PutHabit(ctx context.Context, uid int64, h Habit, version *int) (Habit, error)
	DeleteHabit(ctx context.Context, uid int64, id string, version *int) error
	ListLogs(ctx context.Context, uid int64, from, to string) ([]HabitLog, error)
	PutLog(ctx context.Context, uid int64, l HabitLog, version *int) (HabitLog, error)
	DeleteLog(ctx context.Context, uid int64, habitID, date string, version *int) error
}

// Porter dumps and restores data as JSON, table by table (every user-owned table, or the whole database).
type Porter interface {
	Export(ctx context.Context, uid *int64) (Dump, error)
	Import(ctx context.Context, d Dump) error
}

type Target struct {
	Sets     int `json:"sets"`
	RepsLow  int `json:"repsLow"`
	RepsHigh int `json:"repsHigh"`
}
type RoutineExercise struct {
	ExerciseID string  `json:"exercise_id"`
	Target     *Target `json:"target"`
	RestS      int     `json:"rest_s"`
}
type Routine struct {
	ID        string            `json:"id"`
	Name      string            `json:"name"`
	Exercises []RoutineExercise `json:"exercises"`
}
type Plan struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Days      []string   `json:"days"` // Mon..Sun: a routine id, or "" for rest
	Active    bool       `json:"active"`
	Routines  []Routine  `json:"routines"`
	Version   int        `json:"version"`
	CreatedAt time.Time  `json:"created_at"`
	UpdatedAt time.Time  `json:"updated_at"`
	DeletedAt *time.Time `json:"deleted_at,omitempty"`
}

type WSet struct {
	ID     string     `json:"id"`
	Done   bool       `json:"done"`
	Kg     *float64   `json:"kg"`
	Reps   *int       `json:"reps"` // reps, or seconds for a timed set
	DoneAt *time.Time `json:"done_at"`
}
type WorkoutExercise struct {
	ID         string  `json:"id"`
	ExerciseID string  `json:"exercise_id"`
	Kind       string  `json:"kind"` // weight | bodyweight | time
	RestS      int     `json:"rest_s"`
	Target     *Target `json:"target"`
	Sets       []WSet  `json:"sets"`
}
type Workout struct {
	ID        string            `json:"id"`
	Title     string            `json:"title"`
	PlanID    *string           `json:"plan_id"`
	RoutineID *string           `json:"routine_id"`
	LocalDate string            `json:"local_date"`
	StartedAt time.Time         `json:"started_at"`
	EndedAt   time.Time         `json:"ended_at"`
	Exercises []WorkoutExercise `json:"exercises"`
	Version   int               `json:"version"`
	CreatedAt time.Time         `json:"created_at"`
	UpdatedAt time.Time         `json:"updated_at"`
	DeletedAt *time.Time        `json:"deleted_at,omitempty"`
}

type Habit struct {
	ID            string     `json:"id"`
	Name          string     `json:"name"`
	ShortName     string     `json:"short_name"`
	ShortNameAuto bool       `json:"short_name_auto"`
	Icon          *string    `json:"icon"`
	Kind          string     `json:"kind"`
	TargetValue   *int       `json:"target_value"`
	Unit          *string    `json:"unit"`
	TargetSets    *int       `json:"target_sets"`
	TargetReps    *int       `json:"target_reps"`
	Schedule      string     `json:"schedule"`
	Weekdays      int        `json:"weekdays"`
	StartsOn      string     `json:"starts_on"`
	Position      int        `json:"position"`
	ArchivedAt    *time.Time `json:"archived_at"`
	Version       int        `json:"version"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
	DeletedAt     *time.Time `json:"deleted_at,omitempty"`
}
type HabitLog struct {
	ID             string          `json:"id"`
	HabitID        string          `json:"habit_id"`
	LocalDate      string          `json:"local_date"`
	Value          *int            `json:"value"`
	Done           bool            `json:"done"`
	TargetSnapshot json.RawMessage `json:"target_snapshot"`
	LoggedAt       time.Time       `json:"logged_at"`
	Version        int             `json:"version"`
	UpdatedAt      time.Time       `json:"updated_at"`
	DeletedAt      *time.Time      `json:"deleted_at,omitempty"`
}

// Dump: table name -> rows as JSON objects (row_to_json), in an order that restores (parents first).
type Dump struct {
	Format  string                       `json:"format"` // "stoke-dump-v1"
	UserID  *int64                       `json:"user_id,omitempty"`
	Tables  []string                     `json:"tables"`
	Rows    map[string][]json.RawMessage `json:"rows"`
	Created time.Time                    `json:"created_at"`
}

// PG implements every repository on one pool.
type PG struct{ DB *pgxpool.Pool }

var (
	_ Users    = (*PG)(nil)
	_ Plans    = (*PG)(nil)
	_ Workouts = (*PG)(nil)
	_ Habits   = (*PG)(nil)
	_ Porter   = (*PG)(nil)
)
