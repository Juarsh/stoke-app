package food

import (
	"context"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/akarsh/calorie-tracker/internal/httpx"
)

// Gemini's free tier is a per-project, per-model daily request quota
// (quotaId GenerateRequestsPerDayPerProjectPerModel-FreeTier) that resets at
// midnight Pacific time. Our own counters use the same "quota day", so the
// caps reset when Google's does (12:30 PM IST in PDT, 1:30 PM IST in PST).

// QuotaDefaults; overridden by AI_DAILY_CAP, AI_USER_DAILY_CAP and AI_QUOTA_RESET_TZ.
const (
	DefaultDailyCap     = 20
	DefaultUserDailyCap = 3
	DefaultResetTZ      = "America/Los_Angeles"
)

// Quota is the project's daily AI budget state.
type Quota struct {
	Reset *time.Location // the quota day's zone (Google resets at its midnight)
	// UserCap is the per-user daily cap (0 = no per-user limit).
	UserCap atomic.Int64
	// exhaustedUntil: unix seconds; Google said the daily quota is used up.
	// Persisted in ai_google_exhausted (keyed by Pacific quota day) so a
	// restart does not clear it until the next PerDay 429 / day roll.
	exhaustedUntil atomic.Int64
}

func (q *Quota) loc() *time.Location {
	if q == nil || q.Reset == nil {
		l, err := time.LoadLocation(DefaultResetTZ)
		if err != nil {
			return time.UTC
		}
		return l
	}
	return q.Reset
}

// Day is the current quota day (as a UTC midnight date, like httpx.Today).
func (q *Quota) Day(now time.Time) time.Time {
	t := now.In(q.loc())
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}

// NextReset is the next midnight in the reset zone.
func (q *Quota) NextReset(now time.Time) time.Time {
	t := now.In(q.loc())
	return time.Date(t.Year(), t.Month(), t.Day()+1, 0, 0, 0, 0, q.loc())
}

// MarkExhausted stops Gemini calls until the next reset (in memory only).
func (q *Quota) MarkExhausted(now time.Time) {
	if q != nil {
		q.exhaustedUntil.Store(q.NextReset(now).Unix())
	}
}

// ClearExhausted drops the in-memory exhausted mark (tests / day roll).
func (q *Quota) ClearExhausted() {
	if q != nil {
		q.exhaustedUntil.Store(0)
	}
}

// PersistExhausted writes the exhausted mark for the current Pacific quota day.
func (q *Quota) PersistExhausted(ctx context.Context, db *pgxpool.Pool, now time.Time) {
	if q == nil || db == nil {
		return
	}
	until := q.NextReset(now)
	q.exhaustedUntil.Store(until.Unix())
	day := q.Day(now)
	_, _ = db.Exec(ctx, `INSERT INTO ai_google_exhausted(quota_day, exhausted_until) VALUES ($1,$2)
		ON CONFLICT (quota_day) DO UPDATE SET exhausted_until=EXCLUDED.exhausted_until`, day, until)
	_, _ = db.Exec(ctx, `DELETE FROM ai_google_exhausted WHERE quota_day < $1`, day)
}

// LoadExhausted restores the mark for today's Pacific quota day from the DB.
// Past days are dropped. Call once at process start.
func (q *Quota) LoadExhausted(ctx context.Context, db *pgxpool.Pool, now time.Time) {
	if q == nil || db == nil {
		return
	}
	day := q.Day(now)
	_, _ = db.Exec(ctx, `DELETE FROM ai_google_exhausted WHERE quota_day < $1 OR exhausted_until <= $2`, day, now)
	var until time.Time
	err := db.QueryRow(ctx, `SELECT exhausted_until FROM ai_google_exhausted WHERE quota_day=$1`, day).Scan(&until)
	if err != nil {
		return
	}
	if now.Before(until) {
		q.exhaustedUntil.Store(until.Unix())
	}
}

// Exhausted reports whether Google's daily quota is known to be used up.
func (q *Quota) Exhausted(now time.Time) (bool, time.Time) {
	if q == nil {
		return false, time.Time{}
	}
	u := q.exhaustedUntil.Load()
	if u == 0 || now.Unix() >= u {
		return false, time.Time{}
	}
	return true, time.Unix(u, 0)
}

// isDailyQuota: a 429 QuotaFailure naming a per-day quota.
func isDailyQuota(quotaID string) bool { return strings.Contains(quotaID, "PerDay") }

// handleQuota: GET /admin/ai-quota - the remaining daily AI budget.
func (s *Service) handleQuota(w http.ResponseWriter, r *http.Request) {
	now := httpx.Now()
	day := s.Quota.Day(now)
	var used int64
	_ = s.DB.QueryRow(r.Context(), `SELECT COALESCE((SELECT calls FROM ai_global_usage WHERE local_date=$1),0)`, day).Scan(&used)
	gc := s.GlobalCap.Load()
	ex, until := s.Quota.Exhausted(now)
	out := map[string]any{"quota_day": day.Format("2006-01-02"), "reset_zone": s.Quota.loc().String(),
		"resets_at": s.Quota.NextReset(now).Format(time.RFC3339), "daily_cap": gc, "used": used,
		"user_daily_cap": s.userCap(), "exhausted": ex, "remaining": nil}
	if gc > 0 {
		out["remaining"] = max(0, gc-used)
	}
	if ex {
		out["remaining"] = 0
		out["exhausted_until"] = until.Format(time.RFC3339)
	}
	httpx.JSON(w, 200, out)
}
