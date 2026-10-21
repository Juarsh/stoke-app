package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// FoodEntry is one food_entries row (package food's Entry). Name is
// CustomName as stored; package food puts the dish table's name on it.
type FoodEntry struct {
	ID          int64   `json:"id"`
	LocalDate   string  `json:"local_date"`
	Slot        string  `json:"slot"`
	RawText     string  `json:"raw_text"`
	DishID      *string `json:"dish_id"`
	Name        string  `json:"name"`
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
	Source      string  `json:"source"`
	Confirmed   bool    `json:"confirmed"`
	ClientID    *string `json:"client_id"`
	TableVer    *int    `json:"dish_table_version"`
	CarbsG      float64 `json:"carbs_g"`
	FatG        float64 `json:"fat_g"`
	Span        string  `json:"span"`
	// State: confirmed (counts in totals) or needs_review (counts for the
	// streak only, until confirmed with PATCH {"state":"confirmed"}).
	State        string    `json:"state"`
	SpanPart     int       `json:"span_part"`
	ParseJobID   *string   `json:"parse_job_id"`
	ClientItemID *string   `json:"client_item_id"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
	DeletedAt    *string   `json:"deleted_at"`
	// Version: the server's row version (1 on insert, +1 on every write). PATCH
	// sends back the version the client last saw (409 version_conflict if stale).
	Version int `json:"version"`
}

// FoodJobEntry is an entry saved with a parse job's id (package food's JobEntry).
type FoodJobEntry struct {
	ID           int64   `json:"id"`
	ClientID     *string `json:"client_id"`
	ClientItemID *string `json:"client_item_id"`
	State        string  `json:"state"`
}

// FoodRepo: food_entries and the events written with them (package food).
type FoodRepo interface {
	// EntryByClientID: the user's entry with this client_id, deleted or not.
	EntryByClientID(ctx context.Context, userID int64, clientID string) (FoodEntry, error)
	// InsertEntry stores e (its id, dates, name and version are ignored) and returns the row.
	InsertEntry(ctx context.Context, userID int64, day time.Time, slot, rawText string, e FoodEntry, span string, part int, jobID, clientItemID string) (FoodEntry, error)
	// LogEvent records a 'log' event of n items.
	LogEvent(ctx context.Context, userID int64, n int) error
	ListDay(ctx context.Context, userID int64, day time.Time) ([]FoodEntry, error)
	// EntryByID / EntryByLiveClientID: a live entry by server id or client_id.
	EntryByID(ctx context.Context, userID, id int64) (FoodEntry, error)
	EntryByLiveClientID(ctx context.Context, userID int64, clientID string) (FoodEntry, error)
	// LockEntry: the live entry, locked FOR UPDATE.
	LockEntry(ctx context.Context, userID, id int64) (FoodEntry, error)
	// UpdateEntry writes ne's values on the live row at version (ErrNoRows: deleted or newer).
	UpdateEntry(ctx context.Context, userID, id int64, day time.Time, slot string, ne FoodEntry, version int) (FoodEntry, error)
	// LinkJob sets parse_job_id / client_item_id (empty keeps the stored one) and scans the new version into version.
	LinkJob(ctx context.Context, userID, id int64, jobID, clientItemID string, version *int) error
	// DeleteEntry soft-deletes the live row and scans its local_date into day.
	DeleteEntry(ctx context.Context, userID, id int64, day *time.Time) error
	ChangedSince(ctx context.Context, userID int64, since time.Time) ([]FoodEntry, error)
	// DayTotals scans the day's counted kcal and protein and its entry count.
	DayTotals(ctx context.Context, userID int64, day time.Time, kcal, protein *float64, n *int) error
	// AbandonedJobs counts the user's abandoned ai_parse_jobs rows with this id into n.
	AbandonedJobs(ctx context.Context, userID int64, job string, n *int) error
	// JobEntries: live entries saved with this parse job (rows that fail to scan are skipped).
	JobEntries(ctx context.Context, userID int64, job string) ([]FoodJobEntry, error)
}

const foodCols = `id,local_date,slot,raw_text,dish_id,custom_name,qty,unit,oil_level,kcal_best,kcal_low,kcal_high,protein_best,protein_low,protein_high,source,confirmed,created_at,updated_at,deleted_at,client_id,dish_table_version,carbs_g,fat_g,span,state,span_part,parse_job_id,client_item_id,version`

// scanFood reads one row in foodCols order. Like the old food scan, the
// derived fields are filled even when the scan failed.
func scanFood(row pgx.Row) (FoodEntry, error) {
	var e FoodEntry
	var d time.Time
	var del *time.Time
	err := row.Scan(&e.ID, &d, &e.Slot, &e.RawText, &e.DishID, &e.CustomName, &e.Qty, &e.Unit, &e.OilLevel,
		&e.KcalBest, &e.KcalLow, &e.KcalHigh, &e.ProteinBest, &e.ProteinLow, &e.ProteinHigh, &e.Source, &e.Confirmed, &e.CreatedAt, &e.UpdatedAt, &del, &e.ClientID, &e.TableVer, &e.CarbsG, &e.FatG, &e.Span, &e.State, &e.SpanPart, &e.ParseJobID, &e.ClientItemID, &e.Version)
	e.LocalDate = d.Format("2006-01-02")
	e.Name = e.CustomName
	if del != nil {
		x := del.UTC().Format(time.RFC3339)
		e.DeletedAt = &x
	}
	return e, err
}

// foodList reads every row; a row that fails to scan ends the list with its error.
func foodList(rows pgx.Rows, err error) ([]FoodEntry, error) {
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []FoodEntry{}
	for rows.Next() {
		e, err := scanFood(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, nil
}

func (r repo) EntryByClientID(ctx context.Context, userID int64, clientID string) (FoodEntry, error) {
	return scanFood(r.q.QueryRow(ctx, `SELECT `+foodCols+` FROM food_entries WHERE user_id=$1 AND client_id=$2`, userID, clientID))
}

func (r repo) InsertEntry(ctx context.Context, userID int64, day time.Time, slot, rawText string, e FoodEntry, span string, part int, jobID, clientItemID string) (FoodEntry, error) {
	return scanFood(r.q.QueryRow(ctx, `INSERT INTO food_entries(user_id,local_date,slot,raw_text,dish_id,custom_name,qty,unit,oil_level,
			kcal_best,kcal_low,kcal_high,protein_best,protein_low,protein_high,source,confirmed,client_id,dish_table_version,carbs_g,fat_g,span,state,span_part,parse_job_id,client_item_id)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,COALESCE(NULLIF($23,''),'confirmed'),$24,NULLIF($25,''),NULLIF($26,'')) RETURNING `+foodCols,
		userID, day, slot, rawText, e.DishID, e.CustomName, e.Qty, e.Unit, e.OilLevel,
		e.KcalBest, e.KcalLow, e.KcalHigh, e.ProteinBest, e.ProteinLow, e.ProteinHigh, e.Source, e.Confirmed,
		e.ClientID, e.TableVer, e.CarbsG, e.FatG, span, e.State, part, jobID, clientItemID))
}

func (r repo) LogEvent(ctx context.Context, userID int64, n int) error {
	_, err := r.q.Exec(ctx, `INSERT INTO events(user_id,name,props) VALUES ($1,'log',jsonb_build_object('items',$2::int))`, userID, n)
	return err
}

func (r repo) ListDay(ctx context.Context, userID int64, day time.Time) ([]FoodEntry, error) {
	return foodList(r.q.Query(ctx, `SELECT `+foodCols+` FROM food_entries WHERE user_id=$1 AND local_date=$2 AND deleted_at IS NULL ORDER BY created_at,id`, userID, day))
}

func (r repo) EntryByID(ctx context.Context, userID, id int64) (FoodEntry, error) {
	return scanFood(r.q.QueryRow(ctx, `SELECT `+foodCols+` FROM food_entries WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, id, userID))
}

func (r repo) EntryByLiveClientID(ctx context.Context, userID int64, clientID string) (FoodEntry, error) {
	return scanFood(r.q.QueryRow(ctx, `SELECT `+foodCols+` FROM food_entries WHERE client_id=$1 AND user_id=$2 AND deleted_at IS NULL`, clientID, userID))
}

func (r repo) LockEntry(ctx context.Context, userID, id int64) (FoodEntry, error) {
	return scanFood(r.q.QueryRow(ctx, `SELECT `+foodCols+` FROM food_entries WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE`, id, userID))
}

func (r repo) UpdateEntry(ctx context.Context, userID, id int64, day time.Time, slot string, ne FoodEntry, version int) (FoodEntry, error) {
	return scanFood(r.q.QueryRow(ctx, `UPDATE food_entries SET local_date=$3,slot=$4,dish_id=$5,custom_name=$6,qty=$7,unit=$8,oil_level=$9,
		kcal_best=$10,kcal_low=$11,kcal_high=$12,protein_best=$13,protein_low=$14,protein_high=$15,source=$16,confirmed=($20<>'needs_review'),
		dish_table_version=COALESCE($17,dish_table_version),carbs_g=$18,fat_g=$19,state=COALESCE(NULLIF($20,''),'confirmed'),updated_at=now()
		WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL AND version=$21 RETURNING `+foodCols, id, userID, day, slot, ne.DishID, ne.CustomName, ne.Qty, ne.Unit, ne.OilLevel,
		ne.KcalBest, ne.KcalLow, ne.KcalHigh, ne.ProteinBest, ne.ProteinLow, ne.ProteinHigh, ne.Source, ne.TableVer, ne.CarbsG, ne.FatG, ne.State, version))
}

func (r repo) LinkJob(ctx context.Context, userID, id int64, jobID, clientItemID string, version *int) error {
	return r.q.QueryRow(ctx, `UPDATE food_entries SET parse_job_id=COALESCE(NULLIF($3,''),parse_job_id), client_item_id=COALESCE(NULLIF($4,''),client_item_id)
			WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL RETURNING version`, id, userID, jobID, clientItemID).Scan(version)
}

func (r repo) DeleteEntry(ctx context.Context, userID, id int64, day *time.Time) error {
	return r.q.QueryRow(ctx, `UPDATE food_entries SET deleted_at=now(), updated_at=now() WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL RETURNING local_date`, id, userID).Scan(day)
}

func (r repo) ChangedSince(ctx context.Context, userID int64, since time.Time) ([]FoodEntry, error) {
	return foodList(r.q.Query(ctx, `SELECT `+foodCols+` FROM food_entries WHERE user_id=$1 AND updated_at>$2 ORDER BY updated_at LIMIT 1000`, userID, since))
}

func (r repo) DayTotals(ctx context.Context, userID int64, day time.Time, kcal, protein *float64, n *int) error {
	return r.q.QueryRow(ctx, `SELECT COALESCE(SUM(kcal_best) FILTER (WHERE state<>'needs_review'),0), COALESCE(SUM(protein_best) FILTER (WHERE state<>'needs_review'),0), COUNT(*) FROM food_entries
		WHERE user_id=$1 AND local_date=$2 AND deleted_at IS NULL`, userID, day).Scan(kcal, protein, n)
}

func (r repo) AbandonedJobs(ctx context.Context, userID int64, job string, n *int) error {
	return r.q.QueryRow(ctx, `SELECT count(*) FROM ai_parse_jobs WHERE id=$1 AND user_id=$2 AND status='abandoned'`, job, userID).Scan(n)
}

func (r repo) JobEntries(ctx context.Context, userID int64, job string) ([]FoodJobEntry, error) {
	out := []FoodJobEntry{}
	rows, err := r.q.Query(ctx, `SELECT id, client_id, client_item_id, state FROM food_entries
		WHERE user_id=$1 AND parse_job_id=$2 AND deleted_at IS NULL ORDER BY id`, userID, job)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var e FoodJobEntry
		if rows.Scan(&e.ID, &e.ClientID, &e.ClientItemID, &e.State) == nil {
			out = append(out, e)
		}
	}
	return out, nil
}
