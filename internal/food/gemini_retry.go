package food

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math/rand/v2"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Limiter spaces Gemini HTTP attempts (retries included) to at most RPM a
// minute across the whole process, so queued jobs wait instead of bursting.
type Limiter struct {
	mu   sync.Mutex
	gap  time.Duration
	next time.Time
}

// NewLimiter: rpm attempts a minute; rpm <= 0 means no spacing.
func NewLimiter(rpm int) *Limiter {
	l := &Limiter{}
	if rpm > 0 {
		l.gap = time.Minute / time.Duration(rpm)
	}
	return l
}

// ErrLimiterDeadline: the next free slot is after the caller's deadline.
var ErrLimiterDeadline = errors.New("rate limiter: no slot before the job's deadline")

// Wait blocks until the caller's slot. It never takes a slot it can't use:
// if the slot is past ctx's deadline it returns ErrLimiterDeadline at once.
func (l *Limiter) Wait(ctx context.Context) error {
	if l == nil || l.gap == 0 {
		return ctx.Err()
	}
	l.mu.Lock()
	now := time.Now()
	at := l.next
	if at.Before(now) {
		at = now
	}
	if dl, ok := ctx.Deadline(); ok && at.After(dl) {
		l.mu.Unlock()
		return ErrLimiterDeadline
	}
	l.next = at.Add(l.gap)
	l.mu.Unlock()
	t := time.NewTimer(time.Until(at))
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// AIError describes a failed Gemini call after all attempts. It carries no
// key, prompt or response text, so it is safe to log and to return as
// fallback_reason.
type AIError struct {
	HTTPStatus   int    // last HTTP status (0: no response, e.g. timeout)
	GoogleStatus string // error.status, e.g. RESOURCE_EXHAUSTED
	GoogleCode   int    // error.code
	Model        string
	Attempts     int
	Kind         string // http, timeout, network, rate_limited, bad_answer
	// DailyQuota: a 429 whose QuotaFailure names a per-day quota
	// (GenerateRequestsPerDayPerProjectPerModel-FreeTier). Never retried.
	DailyQuota bool
	QuotaID    string
}

func (e *AIError) Error() string { return "gemini: " + e.Reason() }

// Busy: the provider (or our own limiter) is rate limiting or overloaded.
func (e *AIError) Busy() bool {
	return e.HTTPStatus == 429 || e.HTTPStatus == 503 || e.Kind == "rate_limited"
}

// Code is the machine-readable fallback_reason: daily_limit, rate_limited,
// unavailable, timeout or error.
func (e *AIError) Code() string {
	switch {
	case e.DailyQuota:
		return "daily_limit"
	case e.HTTPStatus == 429 || e.Kind == "rate_limited":
		return "rate_limited"
	case e.HTTPStatus == 503:
		return "unavailable"
	case e.Kind == "timeout":
		return "timeout"
	}
	return "error"
}

// Reason is the detailed log string (status, Google status, model, attempts).
func (e *AIError) Reason() string {
	var b strings.Builder
	switch {
	case e.HTTPStatus != 0:
		fmt.Fprintf(&b, "http_%d", e.HTTPStatus)
		if e.GoogleStatus != "" {
			b.WriteString(" " + e.GoogleStatus)
		}
	default:
		b.WriteString(e.Kind)
	}
	if e.QuotaID != "" {
		b.WriteString(" quota=" + e.QuotaID)
	}
	fmt.Fprintf(&b, " model=%s attempts=%d", e.Model, e.Attempts)
	return b.String()
}

// retryable statuses: rate limited or overloaded.
func retryable(status int) bool { return status == 429 || status == 503 }

// MaxRetries: at most 2 retries (3 HTTP attempts) per meal.
const MaxRetries = 2

// retryDelay: Retry-After (seconds or HTTP date), else the RetryInfo
// retryDelay from the error details, else exponential backoff with full
// jitter (base 1s, 2s).
func retryDelay(h http.Header, retryInfo string, retry int, base time.Duration) time.Duration {
	if v := strings.TrimSpace(h.Get("Retry-After")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			return time.Duration(n) * time.Second
		}
		if t, err := http.ParseTime(v); err == nil {
			return max(0, time.Until(t))
		}
	}
	if retryInfo != "" {
		if d, err := time.ParseDuration(retryInfo); err == nil && d >= 0 {
			return d
		}
	}
	b := base << retry
	return b/2 + time.Duration(rand.Int64N(int64(b/2)+1))
}

// logAttempt logs one failed attempt: status, Google status/code, model,
// attempt number and latency. Never the key or the request body.
func logAttempt(model string, attempt, status int, gstatus string, gcode int, kind string, lat time.Duration, retryIn time.Duration) {
	log.Printf("gemini attempt failed: model=%s attempt=%d/%d http_status=%d google_status=%q google_code=%d kind=%s latency_ms=%d retry_in_ms=%d",
		model, attempt, MaxRetries+1, status, gstatus, gcode, kind, lat.Milliseconds(), retryIn.Milliseconds())
}
