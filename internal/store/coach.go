package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

// ---- coach daily asks (migration 022) -----------------------------------------------------------------------

// TryCoachAsk increments the user's ask count for day when it is below cap.
// ok is false (and the stored count is unchanged) when the cap has already
// been reached. used is the count after a successful reserve, or the current
// count when the cap blocked it.
func (s *PG) TryCoachAsk(ctx context.Context, uid int64, day time.Time, cap int) (used int, ok bool, err error) {
	if cap <= 0 {
		return 0, false, fmt.Errorf("cap must be positive")
	}
	err = s.DB.QueryRow(ctx, `INSERT INTO coach_daily_asks(user_id, day, count)
		VALUES ($1, $2, 1)
		ON CONFLICT (user_id, day)
		DO UPDATE SET count = coach_daily_asks.count + 1
		WHERE coach_daily_asks.count < $3
		RETURNING count`, uid, day, cap).Scan(&used)
	if errors.Is(err, pgx.ErrNoRows) {
		n, err2 := s.CoachAskCount(ctx, uid, day)
		return n, false, err2
	}
	if err != nil {
		return 0, false, err
	}
	return used, true, nil
}

// CoachAskCount is the number of Ask Coach questions already reserved for uid on day (0 if none).
func (s *PG) CoachAskCount(ctx context.Context, uid int64, day time.Time) (int, error) {
	var n int
	err := s.DB.QueryRow(ctx, `SELECT count FROM coach_daily_asks WHERE user_id=$1 AND day=$2`, uid, day).Scan(&n)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	return n, err
}
