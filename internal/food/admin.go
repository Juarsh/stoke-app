package food

import (
	"context"
	"crypto/subtle"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/akarsh/calorie-tracker/internal/dishes"
	"github.com/akarsh/calorie-tracker/internal/httpx"
	"github.com/akarsh/calorie-tracker/internal/parser"
	"github.com/akarsh/calorie-tracker/internal/store"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Live is the dish table the server answers with. An admin import swaps
// in a new published version without a restart.
type Live struct{ p atomic.Pointer[parser.Parser] }

func (l *Live) Get() *parser.Parser  { return l.p.Load() }
func (l *Live) Set(p *parser.Parser) { l.p.Store(p) }
func (s *Service) parser() *parser.Parser {
	if s.Live != nil {
		if p := s.Live.Get(); p != nil {
			return p
		}
	}
	return s.Parser
}

// AdminOnly guards /admin routes with ADMIN_TOKEN ("Authorization: Bearer
// <token>"). With no token configured the routes don't exist (404).
func AdminOnly(token string, h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if token == "" {
			httpx.Error(w, 404, "not found")
			return
		}
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
			httpx.Error(w, 401, "admin token required")
			return
		}
		h.ServeHTTP(w, r)
	})
}

func (s *Service) AdminRoutes(mux *http.ServeMux, token string) {
	mux.Handle("GET /admin/ai-cache/top", AdminOnly(token, http.HandlerFunc(s.handleTopCache)))
	mux.Handle("GET /admin/ai-quota", AdminOnly(token, http.HandlerFunc(s.handleQuota)))
	mux.Handle("POST /admin/dishes/import", AdminOnly(token, http.HandlerFunc(s.handleImport)))
}

// TopCached is one cached AI answer with its hit count, for weekly review.
type TopCached struct {
	Text      string        `json:"text"`
	Hits      int           `json:"hits"`
	FirstSeen string        `json:"first_seen"`
	LastHit   string        `json:"last_hit"`
	Items     []parser.Item `json:"items"`
}

// TopCache returns the most-hit cached AI answers used in the last N days.
func TopCache(ctx context.Context, db *pgxpool.Pool, days, limit int) ([]TopCached, error) {
	rows, err := (&store.PG{DB: db}).AI().TopCache(ctx, days, limit)
	if rows == nil {
		return nil, err // the query or a row failed
	}
	out := []TopCached{}
	for _, c := range rows {
		t := TopCached{Text: c.Text, Hits: c.Hits, FirstSeen: c.FirstSeen, LastHit: c.LastHit}
		_ = json.Unmarshal(c.Items, &t.Items)
		out = append(out, t)
	}
	return out, err // err: the rows' own error after the last row
}

// WriteCSV writes one row per cached item.
func WriteCSV(w *csv.Writer, top []TopCached) error {
	_ = w.Write([]string{"text", "hits", "first_seen", "last_hit", "ai_name", "qty", "unit", "kcal_low", "kcal_best", "kcal_high",
		"protein_low", "protein_best", "protein_high", "carbs_g", "fat_g", "review_status"})
	f := func(x float64) string { return strconv.FormatFloat(x, 'f', -1, 64) }
	for _, t := range top {
		for _, it := range t.Items {
			_ = w.Write([]string{t.Text, strconv.Itoa(t.Hits), t.FirstSeen, t.LastHit, it.Name, f(it.Quantity), it.Unit,
				f(it.Kcal.Low), f(it.Kcal.Best), f(it.Kcal.High), f(it.Protein.Low), f(it.Protein.Best), f(it.Protein.High),
				f(it.CarbsG), f(it.FatG), "unreviewed"})
		}
	}
	w.Flush()
	return w.Error()
}

func (s *Service) handleTopCache(w http.ResponseWriter, r *http.Request) {
	days, limit := 7, 50
	if v, err := strconv.Atoi(r.URL.Query().Get("days")); err == nil && v > 0 && v <= 365 {
		days = v
	}
	if v, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && v > 0 && v <= 1000 {
		limit = v
	}
	top, err := TopCache(r.Context(), s.DB, days, limit)
	if err != nil {
		httpx.Error(w, 500, "db")
		return
	}
	if r.URL.Query().Get("format") == "csv" {
		w.Header().Set("Content-Type", "text/csv")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="ai-cache-top-%s.csv"`, time.Now().Format("2006-01-02")))
		_ = WriteCSV(csv.NewWriter(w), top)
		return
	}
	httpx.JSON(w, 200, map[string]any{"days": days, "top": top})
}

// handleImport publishes checked dishes as a NEW table version: the current
// table plus these rows (new ids are added, existing ids are replaced).
// Every row needs a source and a source_note naming where the numbers were
// checked. Cache entries listed in from_cache are dropped so those meals
// go through the table from now on.
func (s *Service) handleImport(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Items []struct {
			dishes.Dish
			FromCache []string `json:"from_cache"`
		} `json:"items"`
		Note string `json:"note"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if len(in.Items) == 0 || len(in.Items) > 200 {
		httpx.Error(w, 400, "send 1-200 checked items")
		return
	}
	s.importMu.Lock()
	defer s.importMu.Unlock()
	cur := s.parser()
	next := cur.TableVersion() + 1
	table := append([]dishes.Dish(nil), cur.Table()...)
	pos := map[string]int{}
	for i, d := range table {
		pos[d.ID] = i
	}
	added, replaced := []string{}, []string{}
	var drop []string
	for _, it := range in.Items {
		d := it.Dish
		if strings.TrimSpace(d.SourceNote) == "" || d.Source == "" || d.Source == "ai" {
			httpx.Error(w, 400, fmt.Sprintf("dish %q: source (not ai) and source_note are required for checked items", d.ID))
			return
		}
		d.Version = next
		d.NeedsVerify = false
		if i, ok := pos[d.ID]; ok {
			table[i] = d
			replaced = append(replaced, d.ID)
		} else {
			pos[d.ID] = len(table)
			table = append(table, d)
			added = append(added, d.ID)
		}
		for _, c := range it.FromCache {
			drop = append(drop, Normalize(c))
		}
	}
	if err := dishes.Validate(table); err != nil {
		httpx.Error(w, 422, err.Error())
		return
	}
	p, err := parser.New(table)
	if err != nil {
		httpx.Error(w, 422, err.Error())
		return
	}
	vers, err := Publish(r.Context(), s.DB, table, p)
	if err != nil {
		httpx.Error(w, 409, err.Error())
		return
	}
	s.Versions.Adopt(vers)
	if s.Live != nil {
		s.Live.Set(p)
	}
	if len(drop) > 0 {
		_ = s.pg().AI().DropCache(r.Context(), drop)
	}
	_ = s.pg().AI().ImportEvent(r.Context(),
		map[string]any{"version": next, "added": added, "replaced": replaced, "note": in.Note})
	httpx.JSON(w, 201, map[string]any{"dish_table_version": next, "added": added, "replaced": replaced, "dropped_cache": len(drop)})
}
