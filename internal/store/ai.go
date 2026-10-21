package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// ---------- remembered readings (user_readings) ----------

// ReadingRow is one user_readings row (package food's Reading has the same fields).
type ReadingRow struct {
	ID          int64   `json:"id"`
	Span        string  `json:"span"`
	DishID      *string `json:"dish_id"`
	CustomName  string  `json:"custom_name"`
	Qty         float64 `json:"qty"`
	Unit        string  `json:"unit"`
	OilLevel    string  `json:"oil_level"`
	KcalBest    float64 `json:"kcal_best"`
	KcalLow     float64 `json:"kcal_low"`
	KcalHigh    float64 `json:"kcal_high"`
	ProteinBest float64 `json:"protein_best"`
	ProteinLow  float64 `json:"protein_low"`
	ProteinHigh float64 `json:"protein_high"`
	CarbsG      float64 `json:"carbs_g"`
	FatG        float64 `json:"fat_g"`
	Uses        int     `json:"uses"`
	Part        int     `json:"part"`
	UpdatedAt   string  `json:"updated_at"`
}

// ReadingRepo: a user's remembered readings (package food).
type ReadingRepo interface {
	// BySpan: the user's readings by span and part (rows that fail to scan are skipped).
	BySpan(ctx context.Context, userID int64) ([]ReadingRow, error)
	// Recent: the user's readings, newest first (a row that fails to scan is an error).
	Recent(ctx context.Context, userID int64) ([]ReadingRow, error)
	// ForgetSpan drops every part stored for a normalized span.
	ForgetSpan(ctx context.Context, userID int64, normSpan string) error
	// Remember upserts one part of a span from a saved entry.
	Remember(ctx context.Context, userID int64, normSpan string, part int, e FoodEntry) error
	// ResetSpan drops all parts of the span of reading id; it returns the rows deleted.
	ResetSpan(ctx context.Context, userID, id int64) (int64, error)
	// ResetAll drops all the user's readings; it returns the rows deleted.
	ResetAll(ctx context.Context, userID int64) (int64, error)
}

const readingCols = `id,norm_span,dish_id,custom_name,qty::float8,unit,oil_level,kcal_best::float8,kcal_low::float8,kcal_high::float8,
	protein_best::float8,protein_low::float8,protein_high::float8,carbs_g::float8,fat_g::float8,uses,to_char(updated_at,'YYYY-MM-DD"T"HH24:MI:SSOF'),part`

func scanReading(row pgx.Row) (ReadingRow, error) {
	var r ReadingRow
	err := row.Scan(&r.ID, &r.Span, &r.DishID, &r.CustomName, &r.Qty, &r.Unit, &r.OilLevel, &r.KcalBest, &r.KcalLow, &r.KcalHigh,
		&r.ProteinBest, &r.ProteinLow, &r.ProteinHigh, &r.CarbsG, &r.FatG, &r.Uses, &r.UpdatedAt, &r.Part)
	return r, err
}

func (r repo) BySpan(ctx context.Context, userID int64) ([]ReadingRow, error) {
	rows, err := r.q.Query(ctx, `SELECT `+readingCols+` FROM user_readings WHERE user_id=$1 ORDER BY norm_span, part`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ReadingRow
	for rows.Next() {
		if rd, err := scanReading(rows); err == nil {
			out = append(out, rd)
		}
	}
	return out, nil
}

func (r repo) Recent(ctx context.Context, userID int64) ([]ReadingRow, error) {
	rows, err := r.q.Query(ctx, `SELECT `+readingCols+` FROM user_readings WHERE user_id=$1 ORDER BY updated_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ReadingRow{}
	for rows.Next() {
		rd, err := scanReading(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, rd)
	}
	return out, nil
}

func (r repo) ForgetSpan(ctx context.Context, userID int64, normSpan string) error {
	_, err := r.q.Exec(ctx, `DELETE FROM user_readings WHERE user_id=$1 AND norm_span=$2`, userID, normSpan)
	return err
}

func (r repo) Remember(ctx context.Context, userID int64, normSpan string, part int, e FoodEntry) error {
	_, err := r.q.Exec(ctx, `INSERT INTO user_readings(user_id,norm_span,part,dish_id,custom_name,qty,unit,oil_level,kcal_best,kcal_low,kcal_high,
		protein_best,protein_low,protein_high,carbs_g,fat_g) VALUES ($1,$2,$16,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
		ON CONFLICT (user_id,norm_span,part) DO UPDATE SET dish_id=EXCLUDED.dish_id,custom_name=EXCLUDED.custom_name,qty=EXCLUDED.qty,
		unit=EXCLUDED.unit,oil_level=EXCLUDED.oil_level,kcal_best=EXCLUDED.kcal_best,kcal_low=EXCLUDED.kcal_low,kcal_high=EXCLUDED.kcal_high,
		protein_best=EXCLUDED.protein_best,protein_low=EXCLUDED.protein_low,protein_high=EXCLUDED.protein_high,carbs_g=EXCLUDED.carbs_g,
		fat_g=EXCLUDED.fat_g,uses=user_readings.uses+1,updated_at=now()`,
		userID, normSpan, e.DishID, e.CustomName, e.Qty, e.Unit, e.OilLevel, e.KcalBest, e.KcalLow, e.KcalHigh,
		e.ProteinBest, e.ProteinLow, e.ProteinHigh, e.CarbsG, e.FatG, part)
	return err
}

func (r repo) ResetSpan(ctx context.Context, userID, id int64) (int64, error) {
	tag, err := r.q.Exec(ctx, `DELETE FROM user_readings WHERE user_id=$2 AND norm_span=(SELECT norm_span FROM user_readings WHERE id=$1 AND user_id=$2)`, id, userID)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

func (r repo) ResetAll(ctx context.Context, userID int64) (int64, error) {
	tag, err := r.q.Exec(ctx, `DELETE FROM user_readings WHERE user_id=$1`, userID)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// ---------- AI cache, usage counters, call log, quota mark ----------

// CacheRow is one ai_cache row for the export (items as stored JSON).
type CacheRow struct {
	Text      string
	Hits      int
	Items     []byte
	FirstSeen string
	LastHit   string
}

// AIRepo: ai_cache, ai_usage, ai_global_usage, ai_calls, ai_google_exhausted
// and the dish_import event (package food).
type AIRepo interface {
	// ChargeUser counts one call for the user's day unless it is at limit (ErrNoRows: at limit).
	ChargeUser(ctx context.Context, userID int64, day time.Time, limit int64, calls *int) error
	// ChargeGlobal counts one project call for the day unless at limit (0 = none; ErrNoRows: at limit).
	ChargeGlobal(ctx context.Context, day time.Time, limit int64, calls *int64) error
	UnchargeUser(ctx context.Context, userID int64, day time.Time) error
	UnchargeGlobal(ctx context.Context, day time.Time) error
	// GlobalUsed scans the day's project-wide count (0 if none) into used.
	GlobalUsed(ctx context.Context, day time.Time, used *int64) error
	// MarkDied: the meal's in_flight ai_calls rows become died.
	MarkDied(ctx context.Context, mealID string) error
	// StartCall writes an in_flight ai_calls row and scans its id into id.
	StartCall(ctx context.Context, userID int64, mealID string, at time.Time, model string, requeue int, id *int64) error
	FinishCall(ctx context.Context, id int64, outcome string, sends int) error
	// CacheHit counts a hit and scans the cached items into items (ErrNoRows: none).
	CacheHit(ctx context.Context, normText string, items *[]byte) error
	CachePut(ctx context.Context, normText string, items []byte) error
	TopCache(ctx context.Context, days, limit int) ([]CacheRow, error)
	DropCache(ctx context.Context, normTexts []string) error
	ImportEvent(ctx context.Context, props map[string]any) error
	PutExhausted(ctx context.Context, day, until time.Time) error
	DropExhaustedBefore(ctx context.Context, day time.Time) error
	// DropStaleExhausted drops marks of earlier days or that ended by now.
	DropStaleExhausted(ctx context.Context, day, now time.Time) error
	ExhaustedUntil(ctx context.Context, day time.Time, until *time.Time) error
	// ResetAI empties the AI cache, the usage counters and the quota mark (stub test hook; errors ignored).
	ResetAI(ctx context.Context)
}

func (r repo) ChargeUser(ctx context.Context, userID int64, day time.Time, limit int64, calls *int) error {
	return r.q.QueryRow(ctx, `INSERT INTO ai_usage(user_id,local_date,calls) VALUES ($1,$2,1)
		ON CONFLICT (user_id,local_date) DO UPDATE SET calls=ai_usage.calls+1 WHERE ai_usage.calls < $3
		RETURNING calls`, userID, day, limit).Scan(calls)
}

func (r repo) ChargeGlobal(ctx context.Context, day time.Time, limit int64, calls *int64) error {
	return r.q.QueryRow(ctx, `INSERT INTO ai_global_usage(local_date,calls) VALUES ($1,1)
		ON CONFLICT (local_date) DO UPDATE SET calls=ai_global_usage.calls+1 WHERE $2::bigint=0 OR ai_global_usage.calls < $2
		RETURNING calls`, day, limit).Scan(calls)
}

func (r repo) UnchargeUser(ctx context.Context, userID int64, day time.Time) error {
	_, err := r.q.Exec(ctx, `UPDATE ai_usage SET calls=calls-1 WHERE user_id=$1 AND local_date=$2 AND calls>0`, userID, day)
	return err
}

func (r repo) UnchargeGlobal(ctx context.Context, day time.Time) error {
	_, err := r.q.Exec(ctx, `UPDATE ai_global_usage SET calls=calls-1 WHERE local_date=$1 AND calls>0`, day)
	return err
}

func (r repo) GlobalUsed(ctx context.Context, day time.Time, used *int64) error {
	return r.q.QueryRow(ctx, `SELECT COALESCE((SELECT calls FROM ai_global_usage WHERE local_date=$1),0)`, day).Scan(used)
}

func (r repo) MarkDied(ctx context.Context, mealID string) error {
	_, err := r.q.Exec(ctx, `UPDATE ai_calls SET outcome='died' WHERE meal_id=$1 AND outcome='in_flight'`, mealID)
	return err
}

func (r repo) StartCall(ctx context.Context, userID int64, mealID string, at time.Time, model string, requeue int, id *int64) error {
	return r.q.QueryRow(ctx, `INSERT INTO ai_calls(user_id,meal_id,created_at,model,outcome,sends,requeue) VALUES ($1,$2,$3,$4,'in_flight',0,$5) RETURNING id`,
		userID, mealID, at, model, requeue).Scan(id)
}

func (r repo) FinishCall(ctx context.Context, id int64, outcome string, sends int) error {
	_, err := r.q.Exec(ctx, `UPDATE ai_calls SET outcome=$2, sends=$3 WHERE id=$1`, id, outcome, sends)
	return err
}

func (r repo) CacheHit(ctx context.Context, normText string, items *[]byte) error {
	return r.q.QueryRow(ctx, `UPDATE ai_cache SET hits=hits+1, last_hit_at=now() WHERE norm_text=$1 RETURNING items`, normText).Scan(items)
}

func (r repo) CachePut(ctx context.Context, normText string, items []byte) error {
	_, err := r.q.Exec(ctx, `INSERT INTO ai_cache(norm_text,items) VALUES ($1,$2) ON CONFLICT (norm_text) DO NOTHING`, normText, items)
	return err
}

func (r repo) TopCache(ctx context.Context, days, limit int) ([]CacheRow, error) {
	rows, err := r.q.Query(ctx, `SELECT norm_text, hits, items, created_at::date::text, last_hit_at::date::text FROM ai_cache
		WHERE last_hit_at > now() - make_interval(days => $1) ORDER BY hits DESC, norm_text LIMIT $2`, days, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CacheRow{}
	for rows.Next() {
		var c CacheRow
		if err := rows.Scan(&c.Text, &c.Hits, &c.Items, &c.FirstSeen, &c.LastHit); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (r repo) DropCache(ctx context.Context, normTexts []string) error {
	_, err := r.q.Exec(ctx, `DELETE FROM ai_cache WHERE norm_text = ANY($1)`, normTexts)
	return err
}

func (r repo) ImportEvent(ctx context.Context, props map[string]any) error {
	_, err := r.q.Exec(ctx, `INSERT INTO events(user_id,name,props) VALUES (NULL,'dish_import',$1)`, props)
	return err
}

func (r repo) PutExhausted(ctx context.Context, day, until time.Time) error {
	_, err := r.q.Exec(ctx, `INSERT INTO ai_google_exhausted(quota_day, exhausted_until) VALUES ($1,$2)
		ON CONFLICT (quota_day) DO UPDATE SET exhausted_until=EXCLUDED.exhausted_until`, day, until)
	return err
}

func (r repo) DropExhaustedBefore(ctx context.Context, day time.Time) error {
	_, err := r.q.Exec(ctx, `DELETE FROM ai_google_exhausted WHERE quota_day < $1`, day)
	return err
}

func (r repo) DropStaleExhausted(ctx context.Context, day, now time.Time) error {
	_, err := r.q.Exec(ctx, `DELETE FROM ai_google_exhausted WHERE quota_day < $1 OR exhausted_until <= $2`, day, now)
	return err
}

func (r repo) ExhaustedUntil(ctx context.Context, day time.Time, until *time.Time) error {
	return r.q.QueryRow(ctx, `SELECT exhausted_until FROM ai_google_exhausted WHERE quota_day=$1`, day).Scan(until)
}

func (r repo) ResetAI(ctx context.Context) {
	_, _ = r.q.Exec(ctx, `DELETE FROM ai_cache`)
	_, _ = r.q.Exec(ctx, `DELETE FROM ai_global_usage`)
	_, _ = r.q.Exec(ctx, `DELETE FROM ai_usage`)
	_, _ = r.q.Exec(ctx, `DELETE FROM ai_google_exhausted`)
}

// ---------- dish table versions ----------

// DishRepo: dish_table_versions (package food).
type DishRepo interface {
	// PublishVersion stores a snapshot under version v (kept if v exists) and scans the stored sha256 into stored.
	PublishVersion(ctx context.Context, v int, sha string, snapshot []byte, stored *string) error
	// Snapshot scans version v's snapshot into raw (ErrNoRows: unknown).
	Snapshot(ctx context.Context, v int, raw *[]byte) error
	// Versions lists the published versions (rows that fail to scan are skipped).
	Versions(ctx context.Context) ([]int, error)
	// MaxVersion scans the newest version (0 if none) into v.
	MaxVersion(ctx context.Context, v *int) error
	// Newest scans the newest version and its snapshot into v and raw.
	Newest(ctx context.Context, v *int, raw *[]byte) error
}

func (r repo) PublishVersion(ctx context.Context, v int, sha string, snapshot []byte, stored *string) error {
	return r.q.QueryRow(ctx, `INSERT INTO dish_table_versions(version,sha256,snapshot) VALUES ($1,$2,$3)
		ON CONFLICT (version) DO UPDATE SET version=EXCLUDED.version RETURNING sha256`, v, sha, snapshot).Scan(stored)
}

func (r repo) Snapshot(ctx context.Context, v int, raw *[]byte) error {
	return r.q.QueryRow(ctx, `SELECT snapshot FROM dish_table_versions WHERE version=$1`, v).Scan(raw)
}

func (r repo) Versions(ctx context.Context) ([]int, error) {
	out := []int{}
	rows, err := r.q.Query(ctx, `SELECT version FROM dish_table_versions ORDER BY version`)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var v int
		if rows.Scan(&v) == nil {
			out = append(out, v)
		}
	}
	return out, nil
}

func (r repo) MaxVersion(ctx context.Context, v *int) error {
	return r.q.QueryRow(ctx, `SELECT COALESCE(MAX(version),0) FROM dish_table_versions`).Scan(v)
}

func (r repo) Newest(ctx context.Context, v *int, raw *[]byte) error {
	return r.q.QueryRow(ctx, `SELECT version, snapshot FROM dish_table_versions ORDER BY version DESC LIMIT 1`).Scan(v, raw)
}
