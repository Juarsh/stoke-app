// Package summary owns the shared daily_summaries row and streaks.
// Domains (food, activity; later body, workouts) plug in as Contributors,
// so a new pillar adds a contributor and columns, not changes here.
package summary

import (
	"context"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/akarsh/calorie-tracker/internal/httpx"
)

// Querier is satisfied by *pgxpool.Pool and pgx.Tx.
type Querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Day is one user's day. Contributors fill their own fields.
type Day struct {
	LocalDate time.Time `json:"-"`
	Date      string    `json:"date"`
	KcalIn    float64   `json:"kcal_in"`
	ProteinIn float64   `json:"protein_in"`
	KcalOut   float64   `json:"kcal_out"`
	Steps     int       `json:"steps"`
	WaterML   int       `json:"water_ml"`
	Logged    bool      `json:"logged"`
	StreakDay int       `json:"streak_day"`
}

type Contributor interface {
	Name() string
	Contribute(ctx context.Context, q Querier, userID int64, day time.Time, d *Day) error
}

type Service struct {
	DB           *pgxpool.Pool
	Contributors []Contributor
}

// lockUser serialises a user's summary / streak writes (transaction-scoped).
func lockUser(ctx context.Context, tx pgx.Tx, userID int64) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('daily_summaries:' || $1::bigint::text, 0))`, userID)
	return err
}

// Rebuild recomputes the summary row for a day and the user's streak in its
// own transaction (holding the user's advisory lock): for writers whose
// change is already committed (activity). Entry writes use RebuildTx inside
// their own transaction instead (H1: all or nothing).
func (s *Service) Rebuild(ctx context.Context, userID int64, day time.Time) (Day, error) {
	// the write already committed: finish the rebuild even if the client went away
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer cancel()
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Day{LocalDate: day, Date: day.Format("2006-01-02")}, err
	}
	defer tx.Rollback(ctx)
	d, err := s.RebuildTx(ctx, tx, userID, day)
	if err != nil {
		return d, err
	}
	return d, tx.Commit(ctx)
}

// LockUser takes the user's summary lock in tx (transaction-scoped,
// re-entrant). Entry writes take it FIRST, before touching any row, so
// writers of one user run one after another and can't deadlock (G4, H1).
func LockUser(ctx context.Context, tx pgx.Tx, userID int64) error { return lockUser(ctx, tx, userID) }

// RebuildTx recomputes the day's summary row and the streak inside the
// caller's transaction, under the user's advisory lock: the entry write and
// its summary commit together or not at all (H1: a summary that can't be
// written rolls the entry back, so a day is never left with list != summary).
// Reads see every write that committed before the lock was granted plus the
// caller's own (G4).
func (s *Service) RebuildTx(ctx context.Context, tx pgx.Tx, userID int64, day time.Time) (Day, error) {
	d := Day{LocalDate: day, Date: day.Format("2006-01-02")}
	if err := lockUser(ctx, tx, userID); err != nil {
		return d, err
	}
	for _, c := range s.Contributors {
		if err := c.Contribute(ctx, tx, userID, day, &d); err != nil {
			return d, err
		}
	}
	_, err := tx.Exec(ctx, `INSERT INTO daily_summaries(user_id,local_date,kcal_in,protein_in,kcal_out,steps,water_ml,logged,updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
		ON CONFLICT (user_id,local_date) DO UPDATE SET kcal_in=$3,protein_in=$4,kcal_out=$5,steps=$6,water_ml=$7,logged=$8,updated_at=now()`,
		userID, day, d.KcalIn, d.ProteinIn, d.KcalOut, d.Steps, d.WaterML, d.Logged)
	if err != nil {
		return d, err
	}
	st, err := refreshStreak(ctx, tx, userID)
	if err != nil {
		return d, err
	}
	if d.Logged {
		d.StreakDay = st.Current
	}
	if _, err = tx.Exec(ctx, `UPDATE daily_summaries SET streak_day=$3 WHERE user_id=$1 AND local_date=$2`, userID, day, d.StreakDay); err != nil {
		return d, err
	}
	return d, nil
}

// Get returns the stored summary (zero row if none).
func (s *Service) Get(ctx context.Context, userID int64, day time.Time) (Day, error) {
	d := Day{LocalDate: day, Date: day.Format("2006-01-02")}
	err := s.DB.QueryRow(ctx, `SELECT kcal_in,protein_in,kcal_out,steps,water_ml,logged,streak_day FROM daily_summaries WHERE user_id=$1 AND local_date=$2`,
		userID, day).Scan(&d.KcalIn, &d.ProteinIn, &d.KcalOut, &d.Steps, &d.WaterML, &d.Logged, &d.StreakDay)
	if err == pgx.ErrNoRows {
		err = nil
	}
	return d, err
}

// RefreshStreak recomputes the streak from logged days (auto freeze included),
// under the same per-user lock as Rebuild.
func (s *Service) RefreshStreak(ctx context.Context, userID int64) (Streak, error) {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return Streak{}, err
	}
	defer tx.Rollback(ctx)
	if err := lockUser(ctx, tx, userID); err != nil {
		return Streak{}, err
	}
	st, err := refreshStreak(ctx, tx, userID)
	if err != nil {
		return st, err
	}
	return st, tx.Commit(ctx)
}

func refreshStreak(ctx context.Context, q Querier, userID int64) (Streak, error) {
	rows, err := q.Query(ctx, `SELECT local_date FROM daily_summaries WHERE user_id=$1 AND logged ORDER BY local_date`, userID)
	if err != nil {
		return Streak{}, err
	}
	days, err := pgx.CollectRows(rows, pgx.RowTo[time.Time])
	if err != nil {
		return Streak{}, err
	}
	st := Compute(days, httpx.Today())
	_, err = q.Exec(ctx, `INSERT INTO streaks(user_id,current,best,freezes_left,freeze_week,last_logged_date,freeze_used_on,updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,now())
		ON CONFLICT (user_id) DO UPDATE SET current=$2,best=$3,freezes_left=$4,freeze_week=$5,last_logged_date=$6,freeze_used_on=$7,updated_at=now()`,
		userID, st.Current, st.Best, st.FreezesLeft, st.week, st.lastLogged, st.freezeUsed)
	return st, err
}

// --- HTTP ---

func (s *Service) Routes(mux *http.ServeMux, wrap func(http.Handler) http.Handler) {
	mux.Handle("GET /v1/summary", wrap(http.HandlerFunc(s.handleGet)))
	mux.Handle("GET /v1/streak", wrap(http.HandlerFunc(s.handleStreak)))
}

func (s *Service) handleGet(w http.ResponseWriter, r *http.Request) {
	day, ok := httpx.DayParam(w, r)
	if !ok {
		return
	}
	d, err := s.Get(r.Context(), httpx.UserID(r), day)
	if err != nil {
		httpx.Error(w, 500, "summary failed")
		return
	}
	httpx.JSON(w, 200, d)
}

func (s *Service) handleStreak(w http.ResponseWriter, r *http.Request) {
	st, err := s.RefreshStreak(r.Context(), httpx.UserID(r))
	if err != nil {
		httpx.Error(w, 500, "streak failed")
		return
	}
	httpx.JSON(w, 200, st)
}
