// Package food: Hinglish parsing, the fallback, and food_entries (editable
// chips with soft delete and updated_at for offline last-write-wins sync).
package food

import (
	"context"
	"errors"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/akarsh/calorie-tracker/internal/httpx"
	"github.com/akarsh/calorie-tracker/internal/parser"
	"github.com/akarsh/calorie-tracker/internal/summary"
)

type Rebuilder interface {
	Rebuild(ctx context.Context, userID int64, day time.Time) (summary.Day, error)
}

type Service struct {
	DB       *pgxpool.Pool
	Parser   *parser.Parser
	Fallback Fallback
	Summary  Rebuilder
}

// ---------- parse ----------

type Total struct {
	Kcal        float64 `json:"kcal"` // best guess
	KcalLow     float64 `json:"kcal_low"`
	KcalHigh    float64 `json:"kcal_high"`
	ProteinG    float64 `json:"protein_g"` // best guess
	ProteinLow  float64 `json:"protein_low"`
	ProteinHigh float64 `json:"protein_high"`
	CarbsG      float64 `json:"carbs_g"` // estimate
	FatG        float64 `json:"fat_g"`   // estimate
}

type CustomItem struct {
	CustomName string `json:"custom_name"`
	NeedsInput bool   `json:"needs_input"`
}

type ParseResponse struct {
	Items        []parser.Item `json:"items"`
	Unmatched    []string      `json:"unmatched"`
	Total        Total         `json:"total"`
	UsedAI       bool          `json:"used_ai"`
	NeedsConfirm bool          `json:"needs_confirm"` // any item implausibly large; see items[].alternatives
	Fallback     string        `json:"fallback"`      // none, used, not_configured, cap_reached, error
	CustomItems  []CustomItem  `json:"custom_items"`
	Message      string        `json:"message,omitempty"`
	Slot         string        `json:"slot"`
}

func totals(items []parser.Item) Total {
	k, p := parser.Totals(items)
	t := Total{Kcal: k.Best, KcalLow: k.Low, KcalHigh: k.High, ProteinG: p.Best, ProteinLow: p.Low, ProteinHigh: p.High}
	for _, it := range items {
		t.CarbsG += it.CarbsG
		t.FatG += it.FatG
	}
	t.CarbsG, t.FatG = math.Round(t.CarbsG*10)/10, math.Round(t.FatG*10)/10
	return t
}

// Parse runs the table parser, then the fallback for unmatched text within the daily cap.
func (s *Service) Parse(ctx context.Context, userID int64, text string, useAI bool) ParseResponse {
	res := s.Parser.Parse(text)
	out := ParseResponse{Items: res.Items, Unmatched: res.Unmatched, Fallback: "none", CustomItems: []CustomItem{},
		Slot: httpx.SlotFor(httpx.Now())}
	if len(res.Unmatched) > 0 && useAI {
		for _, u := range res.Unmatched {
			st, items := s.fallbackOne(ctx, userID, u)
			if st != "used" {
				out.CustomItems = append(out.CustomItems, CustomItem{CustomName: u, NeedsInput: true})
				if out.Fallback != "used" {
					out.Fallback = st
				}
				continue
			}
			for i := range items {
				items[i].AIEstimate = true
				items[i].Source = "ai"
				items[i].SourceNote = "AI estimate (Gemini) - confirm before saving"
			}
			out.Items = append(out.Items, items...)
			out.UsedAI, out.Fallback = true, "used"
		}
		if out.Fallback == "cap_reached" {
			out.Message = "AI estimates are back tomorrow. Add it yourself for now."
		}
	}
	out.Total = totals(out.Items)
	for _, it := range out.Items {
		out.NeedsConfirm = out.NeedsConfirm || it.NeedsConfirm
	}
	return out
}

func (s *Service) fallbackOne(ctx context.Context, userID int64, text string) (string, []parser.Item) {
	if _, ok := s.Fallback.(NoFallback); ok || s.Fallback == nil {
		return "not_configured", nil
	}
	// reserve one call atomically under the cap
	var calls int
	err := s.DB.QueryRow(ctx, `INSERT INTO ai_usage(user_id,local_date,calls) VALUES ($1,$2,1)
		ON CONFLICT (user_id,local_date) DO UPDATE SET calls=ai_usage.calls+1 WHERE ai_usage.calls < $3
		RETURNING calls`, userID, httpx.Today(), AICapPerDay).Scan(&calls)
	if errors.Is(err, pgx.ErrNoRows) {
		return "cap_reached", nil
	}
	if err != nil {
		return "error", nil
	}
	items, err := s.Fallback.Estimate(ctx, text)
	if errors.Is(err, ErrNotConfigured) {
		return "not_configured", nil
	}
	if err != nil || len(items) == 0 {
		return "error", nil
	}
	return "used", items
}

// ---------- entries ----------

type Entry struct {
	ID          int64     `json:"id"`
	LocalDate   string    `json:"local_date"`
	Slot        string    `json:"slot"`
	RawText     string    `json:"raw_text"`
	DishID      *string   `json:"dish_id"`
	Name        string    `json:"name"`
	CustomName  string    `json:"custom_name"`
	Qty         float64   `json:"qty"`
	Unit        string    `json:"unit"`
	OilLevel    string    `json:"oil_level"`
	KcalBest    float64   `json:"kcal_best"`
	KcalLow     float64   `json:"kcal_low"`
	KcalHigh    float64   `json:"kcal_high"`
	ProteinBest float64   `json:"protein_best"`
	ProteinLow  float64   `json:"protein_low"`
	ProteinHigh float64   `json:"protein_high"`
	Source      string    `json:"source"`
	Confirmed   bool      `json:"confirmed"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
	DeletedAt   *string   `json:"deleted_at"`
}

// ItemIn is one chip the client confirms. Either dish_id (values recomputed
// from our table) or custom_name with the user's/AI's numbers.
type ItemIn struct {
	DishID      string   `json:"dish_id"`
	Qty         float64  `json:"qty"`
	Unit        string   `json:"unit"`
	OilLevel    string   `json:"oil_level"`
	CustomName  string   `json:"custom_name"`
	Kcal        *float64 `json:"kcal"`
	ProteinG    *float64 `json:"protein_g"`
	KcalLow     *float64 `json:"kcal_low"`
	KcalHigh    *float64 `json:"kcal_high"`
	ProteinLow  *float64 `json:"protein_low"`
	ProteinHigh *float64 `json:"protein_high"`
	Source      string   `json:"source"` // ai, manual, custom (dish_id rows are always "table")
}

var slots = map[string]bool{"breakfast": true, "lunch": true, "snacks": true, "dinner": true}

func f(p *float64, d float64) float64 {
	if p == nil {
		return d
	}
	return *p
}

// resolve turns an ItemIn into column values.
func (s *Service) resolve(in ItemIn) (Entry, error) {
	var e Entry
	if in.Qty == 0 {
		in.Qty = 1
	}
	if in.DishID != "" {
		it, err := s.Parser.Recompute(in.DishID, in.Qty, in.Unit, in.OilLevel)
		if err != nil {
			return e, err
		}
		id := it.DishID
		e = Entry{DishID: &id, Name: it.Name, Qty: it.Quantity, Unit: it.Unit, OilLevel: it.OilLevel,
			KcalBest: it.Kcal.Best, KcalLow: it.Kcal.Low, KcalHigh: it.Kcal.High,
			ProteinBest: it.Protein.Best, ProteinLow: it.Protein.Low, ProteinHigh: it.Protein.High, Source: "table"}
		return e, nil
	}
	name := strings.TrimSpace(in.CustomName)
	if name == "" || len(name) > 120 {
		return e, errors.New("each item needs dish_id or custom_name")
	}
	if in.Kcal == nil || *in.Kcal < 0 || *in.Kcal > 5000 {
		return e, errors.New("custom items need kcal (0-5000)")
	}
	pr := f(in.ProteinG, 0)
	if pr < 0 || pr > 300 {
		return e, errors.New("protein_g out of range")
	}
	src := in.Source
	if src == "" {
		src = "custom"
	}
	if src != "ai" && src != "manual" && src != "custom" && src != "barcode" && src != "photo" {
		return e, errors.New("source must be ai, manual, custom, barcode or photo")
	}
	unit := in.Unit
	if unit == "" {
		unit = "count"
	}
	k := *in.Kcal
	return Entry{CustomName: name, Name: name, Qty: in.Qty, Unit: unit, KcalBest: k, KcalLow: f(in.KcalLow, k), KcalHigh: f(in.KcalHigh, k),
		ProteinBest: pr, ProteinLow: f(in.ProteinLow, pr), ProteinHigh: f(in.ProteinHigh, pr), Source: src}, nil
}

const cols = `id,local_date,slot,raw_text,dish_id,custom_name,qty,unit,oil_level,kcal_best,kcal_low,kcal_high,protein_best,protein_low,protein_high,source,confirmed,created_at,updated_at,deleted_at`

func (s *Service) scan(row pgx.Row) (Entry, error) {
	var e Entry
	var d time.Time
	var del *time.Time
	err := row.Scan(&e.ID, &d, &e.Slot, &e.RawText, &e.DishID, &e.CustomName, &e.Qty, &e.Unit, &e.OilLevel,
		&e.KcalBest, &e.KcalLow, &e.KcalHigh, &e.ProteinBest, &e.ProteinLow, &e.ProteinHigh, &e.Source, &e.Confirmed, &e.CreatedAt, &e.UpdatedAt, &del)
	e.LocalDate = d.Format("2006-01-02")
	e.Name = e.CustomName
	if e.DishID != nil {
		if dd, ok := s.Parser.Dish(*e.DishID); ok {
			e.Name = dd.Name
		}
	}
	if del != nil {
		x := del.UTC().Format(time.RFC3339)
		e.DeletedAt = &x
	}
	return e, err
}

func (s *Service) Routes(mux *http.ServeMux, wrap func(http.Handler) http.Handler) {
	mux.Handle("POST /v1/parse", wrap(http.HandlerFunc(s.handleParse)))
	mux.Handle("GET /v1/dishes", http.HandlerFunc(s.handleDishes)) // public: the app's offline table
	mux.Handle("POST /v1/entries", wrap(http.HandlerFunc(s.handleCreate)))
	mux.Handle("GET /v1/entries", wrap(http.HandlerFunc(s.handleList)))
	mux.Handle("GET /v1/entries/{id}", wrap(http.HandlerFunc(s.handleGetOne)))
	mux.Handle("PATCH /v1/entries/{id}", wrap(http.HandlerFunc(s.handlePatch)))
	mux.Handle("DELETE /v1/entries/{id}", wrap(http.HandlerFunc(s.handleDelete)))
	mux.Handle("GET /v1/sync/entries", wrap(http.HandlerFunc(s.handleSync)))
}

func (s *Service) handleParse(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Text  string `json:"text"`
		UseAI *bool  `json:"use_ai"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	in.Text = strings.TrimSpace(in.Text)
	if in.Text == "" || len(in.Text) > 500 {
		httpx.Error(w, 400, "text must be 1-500 characters")
		return
	}
	useAI := in.UseAI == nil || *in.UseAI
	httpx.JSON(w, 200, s.Parse(r.Context(), httpx.UserID(r), in.Text, useAI))
}

func (s *Service) handleDishes(w http.ResponseWriter, r *http.Request) {
	httpx.JSON(w, 200, s.Parser.Table())
}

func (s *Service) handleCreate(w http.ResponseWriter, r *http.Request) {
	var in struct {
		LocalDate string   `json:"local_date"`
		Slot      string   `json:"slot"`
		Text      string   `json:"text"`
		Items     []ItemIn `json:"items"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	day, err := httpx.Day(in.LocalDate)
	if err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	if in.Slot == "" {
		in.Slot = httpx.SlotFor(httpx.Now())
	}
	if !slots[in.Slot] {
		httpx.Error(w, 400, "slot must be breakfast, lunch, snacks or dinner")
		return
	}
	items := in.Items
	var unmatched []string
	if len(items) == 0 && strings.TrimSpace(in.Text) != "" {
		// convenience: save only what the table recognised; unmatched comes back
		p := s.Parser.Parse(in.Text)
		for _, it := range p.Items {
			items = append(items, ItemIn{DishID: it.DishID, Qty: it.Quantity, Unit: it.Unit, OilLevel: it.OilLevel})
		}
		unmatched = p.Unmatched
	}
	if len(items) == 0 || len(items) > 30 {
		httpx.Error(w, 400, "give 1-30 items, or text the table recognises")
		return
	}
	uid := httpx.UserID(r)
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		httpx.Error(w, 500, "db")
		return
	}
	defer tx.Rollback(r.Context())
	out := []Entry{}
	for i, it := range items {
		e, err := s.resolve(it)
		if err != nil {
			httpx.Error(w, 400, "item "+strconv.Itoa(i)+": "+err.Error())
			return
		}
		saved, err := s.scan(tx.QueryRow(r.Context(), `INSERT INTO food_entries(user_id,local_date,slot,raw_text,dish_id,custom_name,qty,unit,oil_level,
			kcal_best,kcal_low,kcal_high,protein_best,protein_low,protein_high,source,confirmed)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true) RETURNING `+cols,
			uid, day, in.Slot, in.Text, e.DishID, e.CustomName, e.Qty, e.Unit, e.OilLevel,
			e.KcalBest, e.KcalLow, e.KcalHigh, e.ProteinBest, e.ProteinLow, e.ProteinHigh, e.Source))
		if err != nil {
			httpx.Error(w, 500, "save failed")
			return
		}
		out = append(out, saved)
	}
	_, _ = tx.Exec(r.Context(), `INSERT INTO events(user_id,name,props) VALUES ($1,'log',jsonb_build_object('items',$2::int))`, uid, len(out))
	if err := tx.Commit(r.Context()); err != nil {
		httpx.Error(w, 500, "save failed")
		return
	}
	sum, err := s.Summary.Rebuild(r.Context(), uid, day)
	if err != nil {
		httpx.Error(w, 500, "summary failed")
		return
	}
	if unmatched == nil {
		unmatched = []string{}
	}
	httpx.JSON(w, 201, map[string]any{"entries": out, "unmatched": unmatched, "summary": sum})
}

func (s *Service) handleList(w http.ResponseWriter, r *http.Request) {
	day, ok := httpx.DayParam(w, r)
	if !ok {
		return
	}
	rows, err := s.DB.Query(r.Context(), `SELECT `+cols+` FROM food_entries WHERE user_id=$1 AND local_date=$2 AND deleted_at IS NULL ORDER BY created_at,id`, httpx.UserID(r), day)
	if err != nil {
		httpx.Error(w, 500, "db")
		return
	}
	defer rows.Close()
	out := []Entry{}
	for rows.Next() {
		e, err := s.scan(rows)
		if err != nil {
			httpx.Error(w, 500, "db")
			return
		}
		out = append(out, e)
	}
	httpx.JSON(w, 200, map[string]any{"local_date": day.Format("2006-01-02"), "entries": out, "total": entryTotals(out)})
}

func entryTotals(es []Entry) Total {
	var t Total
	for _, e := range es {
		t.Kcal += e.KcalBest
		t.KcalLow += e.KcalLow
		t.KcalHigh += e.KcalHigh
		t.ProteinG += e.ProteinBest
		t.ProteinLow += e.ProteinLow
		t.ProteinHigh += e.ProteinHigh
	}
	return t
}

func (s *Service) load(ctx context.Context, uid int64, r *http.Request) (Entry, int, error) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		return Entry{}, 400, errors.New("bad id")
	}
	e, err := s.scan(s.DB.QueryRow(ctx, `SELECT `+cols+` FROM food_entries WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, id, uid))
	if errors.Is(err, pgx.ErrNoRows) {
		return e, 404, errors.New("entry not found")
	}
	if err != nil {
		return e, 500, errors.New("db")
	}
	return e, 0, nil
}

func (s *Service) handleGetOne(w http.ResponseWriter, r *http.Request) {
	e, code, err := s.load(r.Context(), httpx.UserID(r), r)
	if err != nil {
		httpx.Error(w, code, err.Error())
		return
	}
	httpx.JSON(w, 200, e)
}

// handlePatch edits a chip. Dish rows are recomputed from the table; custom
// rows take the given numbers. If the client sends its updated_at and the
// server row is newer, it's a 409 (last write wins on the client after sync).
func (s *Service) handlePatch(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Slot         *string    `json:"slot"`
		LocalDate    *string    `json:"local_date"`
		DishID       *string    `json:"dish_id"`
		Qty          *float64   `json:"qty"`
		Unit         *string    `json:"unit"`
		OilLevel     *string    `json:"oil_level"`
		CustomName   *string    `json:"custom_name"`
		Kcal         *float64   `json:"kcal"`
		ProteinG     *float64   `json:"protein_g"`
		IfUnmodSince *time.Time `json:"if_unmodified_since"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	uid := httpx.UserID(r)
	e, code, err := s.load(r.Context(), uid, r)
	if err != nil {
		httpx.Error(w, code, err.Error())
		return
	}
	if in.IfUnmodSince != nil && e.UpdatedAt.After(*in.IfUnmodSince) {
		httpx.JSON(w, 409, map[string]any{"error": "entry changed on the server", "entry": e})
		return
	}
	oldDay, _ := time.Parse("2006-01-02", e.LocalDate)
	day := oldDay
	if in.LocalDate != nil {
		if day, err = httpx.Day(*in.LocalDate); err != nil {
			httpx.Error(w, 400, err.Error())
			return
		}
	}
	slot := e.Slot
	if in.Slot != nil {
		if !slots[*in.Slot] {
			httpx.Error(w, 400, "slot must be breakfast, lunch, snacks or dinner")
			return
		}
		slot = *in.Slot
	}
	it := ItemIn{Qty: e.Qty, Unit: e.Unit, OilLevel: e.OilLevel, CustomName: e.CustomName, Source: e.Source}
	if e.DishID != nil {
		it.DishID = *e.DishID
	} else {
		k, p := e.KcalBest, e.ProteinBest
		it.Kcal, it.ProteinG = &k, &p
		if e.Source == "table" {
			it.Source = "custom"
		}
	}
	if in.DishID != nil {
		it.DishID = *in.DishID
		if *in.DishID != "" && in.Unit == nil {
			it.Unit = "" // use the new dish's default unit
		}
	}
	if in.Qty != nil {
		// custom items scale their numbers with quantity
		if it.DishID == "" && e.Qty > 0 {
			k, p := *it.Kcal**in.Qty/e.Qty, *it.ProteinG**in.Qty/e.Qty
			it.Kcal, it.ProteinG = &k, &p
		}
		it.Qty = *in.Qty
	}
	if in.Unit != nil {
		it.Unit = *in.Unit
	}
	if in.OilLevel != nil {
		it.OilLevel = *in.OilLevel
	}
	if in.CustomName != nil {
		it.CustomName = *in.CustomName
	}
	if in.Kcal != nil {
		it.Kcal = in.Kcal
	}
	if in.ProteinG != nil {
		it.ProteinG = in.ProteinG
	}
	if it.DishID == "" && in.Kcal != nil {
		it.Source = "manual"
	}
	ne, err := s.resolve(it)
	if err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	saved, err := s.scan(s.DB.QueryRow(r.Context(), `UPDATE food_entries SET local_date=$3,slot=$4,dish_id=$5,custom_name=$6,qty=$7,unit=$8,oil_level=$9,
		kcal_best=$10,kcal_low=$11,kcal_high=$12,protein_best=$13,protein_low=$14,protein_high=$15,source=$16,confirmed=true,updated_at=now()
		WHERE id=$1 AND user_id=$2 RETURNING `+cols, e.ID, uid, day, slot, ne.DishID, ne.CustomName, ne.Qty, ne.Unit, ne.OilLevel,
		ne.KcalBest, ne.KcalLow, ne.KcalHigh, ne.ProteinBest, ne.ProteinLow, ne.ProteinHigh, ne.Source))
	if err != nil {
		httpx.Error(w, 500, "save failed")
		return
	}
	if !day.Equal(oldDay) {
		if _, err := s.Summary.Rebuild(r.Context(), uid, oldDay); err != nil {
			httpx.Error(w, 500, "summary failed")
			return
		}
	}
	if _, err := s.Summary.Rebuild(r.Context(), uid, day); err != nil {
		httpx.Error(w, 500, "summary failed")
		return
	}
	httpx.JSON(w, 200, saved)
}

func (s *Service) handleDelete(w http.ResponseWriter, r *http.Request) {
	uid := httpx.UserID(r)
	e, code, err := s.load(r.Context(), uid, r)
	if err != nil {
		httpx.Error(w, code, err.Error())
		return
	}
	if _, err := s.DB.Exec(r.Context(), `UPDATE food_entries SET deleted_at=now(), updated_at=now() WHERE id=$1 AND user_id=$2`, e.ID, uid); err != nil {
		httpx.Error(w, 500, "delete failed")
		return
	}
	day, _ := time.Parse("2006-01-02", e.LocalDate)
	if _, err := s.Summary.Rebuild(r.Context(), uid, day); err != nil {
		httpx.Error(w, 500, "summary failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleSync returns every entry changed since ?since= (RFC 3339), including
// soft-deleted ones, so the app's SQLite copy can catch up.
func (s *Service) handleSync(w http.ResponseWriter, r *http.Request) {
	since := time.Unix(0, 0)
	if v := r.URL.Query().Get("since"); v != "" {
		t, err := time.Parse(time.RFC3339Nano, v)
		if err != nil {
			httpx.Error(w, 400, "since must be RFC 3339")
			return
		}
		since = t
	}
	rows, err := s.DB.Query(r.Context(), `SELECT `+cols+` FROM food_entries WHERE user_id=$1 AND updated_at>$2 ORDER BY updated_at LIMIT 1000`, httpx.UserID(r), since)
	if err != nil {
		httpx.Error(w, 500, "db")
		return
	}
	defer rows.Close()
	out := []Entry{}
	for rows.Next() {
		e, err := s.scan(rows)
		if err != nil {
			httpx.Error(w, 500, "db")
			return
		}
		out = append(out, e)
	}
	httpx.JSON(w, 200, map[string]any{"entries": out, "server_time": time.Now().UTC().Format(time.RFC3339Nano)})
}

// ---------- summary contributor ----------

type Contributor struct{}

func (Contributor) Name() string { return "food" }

func (Contributor) Contribute(ctx context.Context, q summary.Querier, uid int64, day time.Time, d *summary.Day) error {
	var n int
	err := q.QueryRow(ctx, `SELECT COALESCE(SUM(kcal_best),0), COALESCE(SUM(protein_best),0), COUNT(*) FROM food_entries
		WHERE user_id=$1 AND local_date=$2 AND deleted_at IS NULL`, uid, day).Scan(&d.KcalIn, &d.ProteinIn, &n)
	d.Logged = d.Logged || n > 0
	return err
}
