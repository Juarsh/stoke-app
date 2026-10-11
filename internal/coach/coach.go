// Package coach suggests 3 Indian options from the dish table that fill the
// day's remaining calories and protein. Rule-based in v1: it matches the
// user's veg/egg/non-veg setting and never pushes past the calorie target
// (the high end of every option's range must fit what's left). An LLM can
// reword or re-rank later through the Advisor hook.
package coach

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/akarsh/calorie-tracker/internal/dishes"
	"github.com/akarsh/calorie-tracker/internal/goals"
	"github.com/akarsh/calorie-tracker/internal/httpx"
	"github.com/akarsh/calorie-tracker/internal/parser"
	"github.com/akarsh/calorie-tracker/internal/summary"
)

type OptionItem struct {
	DishID   string  `json:"dish_id"`
	Name     string  `json:"name"`
	Qty      float64 `json:"qty"`
	Unit     string  `json:"unit"`
	OilLevel string  `json:"oil_level"`
}

type Option struct {
	Title    string       `json:"title"`
	Items    []OptionItem `json:"items"` // POST these to /v1/entries for one-tap Log
	Kcal     float64      `json:"kcal"`
	KcalHigh float64      `json:"kcal_high"`
	ProteinG float64      `json:"protein_g"`
	score    float64
}

type Input struct {
	KcalLeft    float64
	ProteinLeft float64
	Diet        string
	Slot        string
}

// Advisor is the LLM hook (re-rank / reword). Rules is the v1 default.
type Advisor interface {
	Refine(ctx context.Context, in Input, opts []Option) ([]Option, error)
}

type NoAdvisor struct{}

func (NoAdvisor) Refine(_ context.Context, _ Input, o []Option) ([]Option, error) { return o, nil }

var skipCat = map[string]bool{"condiment": true, "sweet": true}
var skipID = map[string]bool{"cola": true, "juice": true, "black_coffee": true, "chai": true, "coffee": true, "nimbu_pani": true, "coconut_water": true, "salad": true, "papad": true, "biscuit": true, "namkeen": true, "almonds": true}
var breads = []string{"roti", "protein_atta_roti"}

var multiCount = map[string]bool{"boiled_egg": true, "idli": true, "roti": true, "protein_atta_roti": true, "besan_chilla": true, "moong_chilla": true, "dosa": true}

func qtys(d dishes.Dish) []float64 {
	switch {
	case d.ID == "protein_shake":
		return []float64{1} // one scoop; the coach never stacks supplements
	case multiCount[d.ID]:
		return []float64{1, 2, 3, 4}
	case d.Unit == "count":
		return []float64{1, 2}
	}
	return []float64{0.5, 1, 1.5, 2}
}

// Suggest builds up to 3 options. Pure function over the table (tested without a DB).
func Suggest(p *parser.Parser, in Input) []Option {
	if in.KcalLeft < 80 {
		return []Option{}
	}
	var cands []Option
	add := func(parts ...OptionItem) {
		var o Option
		var names []string
		for _, it := range parts {
			c, err := p.Recompute(it.DishID, it.Qty, it.Unit, it.OilLevel)
			if err != nil {
				return
			}
			o.Kcal += c.Kcal.Best
			o.KcalHigh += c.Kcal.High
			o.ProteinG += c.Protein.Best
			it.Name, it.Unit, it.OilLevel = c.Name, c.Unit, c.OilLevel
			o.Items = append(o.Items, it)
			names = append(names, fmt.Sprintf("%s %s %s", trim(it.Qty), unitLabel(it.Unit, it.Qty), c.Name))
		}
		if o.KcalHigh > in.KcalLeft {
			return // never push past the target
		}
		o.Title = strings.Join(names, " + ")
		pFit := 1.0
		if in.ProteinLeft > 1 {
			pFit = math.Min(o.ProteinG, in.ProteinLeft) / in.ProteinLeft
		}
		o.score = 0.65*pFit + 0.35*(o.Kcal/in.KcalLeft) + 0.002*o.ProteinG/math.Max(o.Kcal, 1)*100
		cands = append(cands, o)
	}
	var mains []dishes.Dish
	for _, d := range p.Table() {
		// branded rows are for logging what people ate, not for recommending brands
		if !d.Allowed(in.Diet) || skipCat[d.Category] || skipID[d.ID] || d.Unit == "spoon" || d.Brand != "" || d.NeedsConfirm {
			continue
		}
		oil := ""
		if d.OilSensitive {
			oil = "less"
		}
		for _, q := range qtys(d) {
			add(OptionItem{DishID: d.ID, Qty: q, Unit: d.Unit, OilLevel: oil})
		}
		if d.ProteinG/math.Max(d.Kcal, 1) >= 0.05 && (d.Category == "protein" || d.Category == "dal" || d.Category == "main") && d.Unit != "glass" && d.ID != "protein_shake" {
			mains = append(mains, d)
		}
	}
	for _, d := range mains {
		oil := ""
		if d.OilSensitive {
			oil = "less"
		}
		for _, b := range breads {
			for _, bq := range []float64{1, 2} {
				for _, q := range qtys(d)[:min(2, len(qtys(d)))] {
					add(OptionItem{DishID: d.ID, Qty: q, Unit: d.Unit, OilLevel: oil}, OptionItem{DishID: b, Qty: bq, Unit: "count"})
				}
			}
		}
	}
	sort.SliceStable(cands, func(i, j int) bool { return cands[i].score > cands[j].score })
	out := []Option{}
	used := map[string]bool{}
	drinks := 0
	for _, c := range cands {
		key := c.Items[0].DishID
		d, _ := p.Dish(key)
		isDrink := d.Category == "drink" || d.Unit == "glass"
		if used[key] || (isDrink && drinks >= 1) {
			continue
		}
		if isDrink {
			drinks++
		}
		used[key] = true
		out = append(out, c)
		if len(out) == 3 {
			break
		}
	}
	return out
}

func trim(f float64) string { return strings.TrimSuffix(fmt.Sprintf("%.1f", f), ".0") }

func unitLabel(u string, q float64) string {
	if u == "count" {
		return "x"
	}
	return u
}

type Service struct {
	Parser *parser.Parser
	// Table, when set, returns the live dish table (admin imports swap it).
	Table   func() *parser.Parser
	Goals   *goals.Service
	Summary *summary.Service
	Advisor Advisor
}

func (s *Service) Routes(mux *http.ServeMux, wrap func(http.Handler) http.Handler) {
	mux.Handle("GET /v1/coach/suggestions", wrap(http.HandlerFunc(s.handle)))
}

// Remaining is what's left for a day. Steps calories are added only when the
// user turned that setting on.
type Remaining struct {
	Date        string  `json:"date"`
	KcalTarget  float64 `json:"kcal_target"`
	ProteinTgt  float64 `json:"protein_target"`
	KcalIn      float64 `json:"kcal_in"`
	ProteinIn   float64 `json:"protein_in"`
	KcalOut     float64 `json:"kcal_out"`
	StepsInBud  bool    `json:"steps_in_budget"`
	KcalLeft    float64 `json:"kcal_left"` // negative = over (shown neutral grey in the app)
	ProteinLeft float64 `json:"protein_left"`
}

func (s *Service) Remaining(ctx context.Context, uid int64, day time.Time) (*Remaining, error) {
	t, err := s.Goals.TargetFor(ctx, uid, day)
	if err != nil || t == nil {
		return nil, err
	}
	d, err := s.Summary.Get(ctx, uid, day)
	if err != nil {
		return nil, err
	}
	r := &Remaining{Date: d.Date, KcalTarget: float64(t.Kcal), ProteinTgt: float64(t.ProteinG), KcalIn: d.KcalIn, ProteinIn: d.ProteinIn,
		KcalOut: d.KcalOut, StepsInBud: s.Goals.StepsInBudget(ctx, uid)}
	budget := r.KcalTarget
	if r.StepsInBud {
		budget += d.KcalOut
	}
	r.KcalLeft = math.Round(budget - d.KcalIn)
	r.ProteinLeft = math.Round(math.Max(0, r.ProteinTgt-d.ProteinIn)*10) / 10
	return r, nil
}

func (s *Service) handle(w http.ResponseWriter, r *http.Request) {
	day, ok := httpx.DayParam(w, r)
	if !ok {
		return
	}
	uid := httpx.UserID(r)
	rem, err := s.Remaining(r.Context(), uid, day)
	if err != nil {
		httpx.Error(w, 500, "lookup failed")
		return
	}
	if rem == nil {
		httpx.Error(w, 404, "no target yet; PUT /v1/profile first")
		return
	}
	in := Input{KcalLeft: rem.KcalLeft, ProteinLeft: rem.ProteinLeft, Diet: s.Goals.Diet(r.Context(), uid), Slot: httpx.SlotFor(httpx.Now())}
	tp := s.Parser
	if s.Table != nil {
		tp = s.Table()
	}
	opts := Suggest(tp, in)
	if ref, err := s.Advisor.Refine(r.Context(), in, opts); err == nil {
		opts = ref
	}
	msg := fmt.Sprintf("You have %.0f kcal and %.0f g protein left.", math.Max(0, rem.KcalLeft), rem.ProteinLeft)
	if len(opts) == 0 {
		msg = "You're at today's target. Nice work."
		if rem.KcalLeft < 0 {
			msg = fmt.Sprintf("%.0f kcal over today.", -rem.KcalLeft)
		}
	}
	httpx.JSON(w, 200, map[string]any{"remaining": rem, "message": msg, "options": opts, "engine": "rules"})
}
