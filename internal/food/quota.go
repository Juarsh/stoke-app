package food

import (
	"net/http"
	"strings"
	"sync/atomic"
	"time"

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

// MarkExhausted stops Gemini calls until the next reset.
func (q *Quota) MarkExhausted(now time.Time) {
	if q != nil {
		q.exhaustedUntil.Store(q.NextReset(now).Unix())
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
