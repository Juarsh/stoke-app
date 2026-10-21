// Package summary owns the shared daily_summaries row and streaks.
// Domains (food, activity; later body, workouts) plug in as Contributors,
// so a new pillar adds a contributor and columns, not changes here.
package summary

import (
	"context"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/akarsh/calorie-tracker/internal/httpx"
	"github.com/akarsh/calorie-tracker/internal/store"
)

// Querier is satisfied by the pool (*store.PG) and a transaction (*store.Tx).
type Querier = store.Querier

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
func lockUser(ctx context.Context, tx *store.Tx, userID int64) error {
	return tx.Summaries().LockUser(ctx, userID)
}

// Rebuild recomputes the summary row for a day and the user's streak in its
// own transaction (holding the user's advisory lock): for writers whose
// change is already committed (activity). Entry writes use RebuildTx inside
// their own transaction instead (H1: all or nothing).
func (s *Service) Rebuild(ctx context.Context, userID int64, day time.Time) (Day, error) {
	// the write already committed: finish the rebuild even if the client went away
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer cancel()
	tx, err := s.pg().Begin(ctx)
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
func LockUser(ctx context.Context, tx *store.Tx, userID int64) error {
	return lockUser(ctx, tx, userID)
}

// RebuildTx recomputes the day's summary row and the streak inside the
// caller's transaction, under the user's advisory lock: the entry write and
// its summary commit together or not at all (H1: a summary that can't be
// written rolls the entry back, so a day is never left with list != summary).
// Reads see every write that committed before the lock was granted plus the
// caller's own (G4).
func (s *Service) RebuildTx(ctx context.Context, tx *store.Tx, userID int64, day time.Time) (Day, error) {
	d := Day{LocalDate: day, Date: day.Format("2006-01-02")}
	if err := lockUser(ctx, tx, userID); err != nil {
		return d, err
	}
	for _, c := range s.Contributors {
		if err := c.Contribute(ctx, tx, userID, day, &d); err != nil {
			return d, err
		}
	}
	err := tx.Summaries().PutDay(ctx, userID, day, d.KcalIn, d.ProteinIn, d.KcalOut, d.Steps, d.WaterML, d.Logged)
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
	if err = tx.Summaries().SetStreakDay(ctx, userID, day, d.StreakDay); err != nil {
		return d, err
	}
	return d, nil
}

// Get returns the stored summary (zero row if none).
func (s *Service) Get(ctx context.Context, userID int64, day time.Time) (Day, error) {
	d := Day{LocalDate: day, Date: day.Format("2006-01-02")}
	err := s.pg().Summaries().GetDay(ctx, userID, day, &d.KcalIn, &d.ProteinIn, &d.KcalOut, &d.Steps, &d.WaterML, &d.Logged, &d.StreakDay)
	if err == store.ErrNoRows {
		err = nil
	}
	return d, err
}

// RefreshStreak recomputes the streak from logged days (auto freeze included),
// under the same per-user lock as Rebuild.
func (s *Service) RefreshStreak(ctx context.Context, userID int64) (Streak, error) {
	tx, err := s.pg().Begin(ctx)
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

func refreshStreak(ctx context.Context, tx *store.Tx, userID int64) (Streak, error) {
	days, err := tx.Summaries().LoggedDays(ctx, userID)
	if err != nil {
		return Streak{}, err
	}
	st := Compute(days, httpx.Today())
	err = tx.Summaries().PutStreak(ctx, userID, st.Current, st.Best, st.FreezesLeft, st.week, st.lastLogged, st.freezeUsed)
	return st, err
}

// pg: the store on this service's pool.
func (s *Service) pg() *store.PG { return &store.PG{DB: s.DB} }

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
