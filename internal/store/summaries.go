package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// SummaryRepo: daily_summaries and streaks (package summary).
type SummaryRepo interface {
	// LockUser takes the user's summary advisory lock (transaction-scoped).
	LockUser(ctx context.Context, userID int64) error
	PutDay(ctx context.Context, userID int64, day time.Time, kcalIn, proteinIn, kcalOut float64, steps, waterML int, logged bool) error
	SetStreakDay(ctx context.Context, userID int64, day time.Time, streakDay int) error
	// GetDay scans the stored row into the given fields (ErrNoRows: none).
	GetDay(ctx context.Context, userID int64, day time.Time, kcalIn, proteinIn, kcalOut *float64, steps, waterML *int, logged *bool, streakDay *int) error
	LoggedDays(ctx context.Context, userID int64) ([]time.Time, error)
	PutStreak(ctx context.Context, userID int64, current, best, freezesLeft int, week time.Time, lastLogged, freezeUsed *time.Time) error
}

func (r repo) LockUser(ctx context.Context, userID int64) error {
	_, err := r.q.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('daily_summaries:' || $1::bigint::text, 0))`, userID)
	return err
}

func (r repo) PutDay(ctx context.Context, userID int64, day time.Time, kcalIn, proteinIn, kcalOut float64, steps, waterML int, logged bool) error {
	_, err := r.q.Exec(ctx, `INSERT INTO daily_summaries(user_id,local_date,kcal_in,protein_in,kcal_out,steps,water_ml,logged,updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
		ON CONFLICT (user_id,local_date) DO UPDATE SET kcal_in=$3,protein_in=$4,kcal_out=$5,steps=$6,water_ml=$7,logged=$8,updated_at=now()`,
		userID, day, kcalIn, proteinIn, kcalOut, steps, waterML, logged)
	return err
}

func (r repo) SetStreakDay(ctx context.Context, userID int64, day time.Time, streakDay int) error {
	_, err := r.q.Exec(ctx, `UPDATE daily_summaries SET streak_day=$3 WHERE user_id=$1 AND local_date=$2`, userID, day, streakDay)
	return err
}

func (r repo) GetDay(ctx context.Context, userID int64, day time.Time, kcalIn, proteinIn, kcalOut *float64, steps, waterML *int, logged *bool, streakDay *int) error {
	return r.q.QueryRow(ctx, `SELECT kcal_in,protein_in,kcal_out,steps,water_ml,logged,streak_day FROM daily_summaries WHERE user_id=$1 AND local_date=$2`,
		userID, day).Scan(kcalIn, proteinIn, kcalOut, steps, waterML, logged, streakDay)
}

func (r repo) LoggedDays(ctx context.Context, userID int64) ([]time.Time, error) {
	rows, err := r.q.Query(ctx, `SELECT local_date FROM daily_summaries WHERE user_id=$1 AND logged ORDER BY local_date`, userID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[time.Time])
}

func (r repo) PutStreak(ctx context.Context, userID int64, current, best, freezesLeft int, week time.Time, lastLogged, freezeUsed *time.Time) error {
	_, err := r.q.Exec(ctx, `INSERT INTO streaks(user_id,current,best,freezes_left,freeze_week,last_logged_date,freeze_used_on,updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,now())
		ON CONFLICT (user_id) DO UPDATE SET current=$2,best=$3,freezes_left=$4,freeze_week=$5,last_logged_date=$6,freeze_used_on=$7,updated_at=now()`,
		userID, current, best, freezesLeft, week, lastLogged, freezeUsed)
	return err
}

// ActivityRepo: activity_entries (package activity).
type ActivityRepo interface {
	PutSteps(ctx context.Context, userID int64, day time.Time, source string, steps int, kcalBurned float64, externalID string) error
	// StepsDay scans the day's largest steps and kcal_burned into steps and kcal.
	StepsDay(ctx context.Context, userID int64, day time.Time, steps *int, kcal *float64) error
}

func (r repo) PutSteps(ctx context.Context, userID int64, day time.Time, source string, steps int, kcalBurned float64, externalID string) error {
	_, err := r.q.Exec(ctx, `INSERT INTO activity_entries(user_id,local_date,kind,source,steps,kcal_burned,external_id)
			VALUES ($1,$2,'steps',$3,$4,$5,$6)
			ON CONFLICT (user_id,source,external_id) WHERE external_id IS NOT NULL
			DO UPDATE SET steps=EXCLUDED.steps,kcal_burned=EXCLUDED.kcal_burned,local_date=EXCLUDED.local_date,deleted_at=NULL,updated_at=now()`,
		userID, day, source, steps, kcalBurned, externalID)
	return err
}

func (r repo) StepsDay(ctx context.Context, userID int64, day time.Time, steps *int, kcal *float64) error {
	return r.q.QueryRow(ctx, `SELECT COALESCE(MAX(steps),0), COALESCE(MAX(kcal_burned),0) FROM activity_entries
		WHERE user_id=$1 AND local_date=$2 AND kind='steps' AND deleted_at IS NULL`, userID, day).Scan(steps, kcal)
}
