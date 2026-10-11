// Package parser turns Hinglish meal text ("2 roti dal sabzi thoda ghee")
// into dish items with quantity, unit, oil level and kcal/protein ranges.
// All vocabulary lives in rules.json and the dish table so the app's
// TypeScript port can reuse the same data.
package parser

import (
	_ "embed"
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"strconv"
	"strings"

	"github.com/akarsh/calorie-tracker/internal/dishes"
)

//go:embed rules.json
var rulesJSON []byte

type unitRule struct {
	Words  []string `json:"words"`
	Grams  float64  `json:"grams"`
	As     string   `json:"as"`
	Factor float64  `json:"factor"`
}

// Rules is the data-driven vocabulary.
type Rules struct {
	Numbers         map[string]float64  `json:"numbers"`
	HalfSuffixes    []string            `json:"half_suffixes"`
	Units           map[string]unitRule `json:"units"`
	OilWords        map[string][]string `json:"oil_words"`
	OilNouns        []string            `json:"oil_nouns"`
	SmallWords      []string            `json:"small_words"`
	FatDishes       []string            `json:"fat_dishes"`
	SmallFatSpoons  float64             `json:"small_fat_spoons"`
	DefaultFatSpoon float64             `json:"default_fat_spoons"`
	ExtraFatSpoons  float64             `json:"extra_fat_spoons"`
	OilKcalPer150g  float64             `json:"oil_kcal_per_150g"`
	Fillers         []string            `json:"fillers"`
	FuzzyMinLen     int                 `json:"fuzzy_min_len"`
	FuzzyMaxDist    int                 `json:"fuzzy_max_dist"`
}

// Range is a low / best-guess / high triple.
type Range struct {
	Low  float64 `json:"low"`
	Best float64 `json:"best"`
	High float64 `json:"high"`
}

// Item is one parsed dish.
type Item struct {
	DishID     string  `json:"dish_id"`
	Name       string  `json:"name"`
	Matched    string  `json:"matched_text"`
	Quantity   float64 `json:"quantity"`
	Unit       string  `json:"unit"` // count, katori, spoon, plate, glass, gram
	Grams      float64 `json:"grams"`
	OilLevel   string  `json:"oil_level"` // less, normal, extra ("" when the dish has no cooking oil)
	Kcal       Range   `json:"kcal"`
	Protein    Range   `json:"protein_g"`
	Source     string  `json:"source"`
	SourceNote string  `json:"source_note"`
	Fuzzy      bool    `json:"fuzzy"`
	AIEstimate bool    `json:"ai_estimate"`
}

// Result is a parsed meal.
type Result struct {
	Items     []Item   `json:"items"`
	Unmatched []string `json:"unmatched"`
}

type tokKind int

const (
	tWord tokKind = iota
	tNum
)

type Parser struct {
	r       Rules
	dish    map[string]*dishes.Dish // term -> dish
	byID    map[string]*dishes.Dish
	table   []dishes.Dish
	maxLen  int
	single  []string // single-word terms for fuzzy
	unitOf  map[string]string
	oilOf   map[string]string
	small   map[string]bool
	oilNoun map[string]bool
	filler  map[string]bool
	fat     map[string]bool
}

// New builds a parser from the embedded rules and the given dish table.
func New(ds []dishes.Dish) (*Parser, error) {
	p := &Parser{dish: map[string]*dishes.Dish{}, byID: map[string]*dishes.Dish{}, table: ds, unitOf: map[string]string{}, oilOf: map[string]string{},
		small: set(nil), oilNoun: set(nil), filler: set(nil), fat: set(nil)}
	if err := json.Unmarshal(rulesJSON, &p.r); err != nil {
		return nil, err
	}
	for i := range ds {
		d := &ds[i]
		p.byID[d.ID] = d
		for _, t := range append([]string{d.Name, d.ID}, d.Aliases...) {
			t = strings.Join(strings.Fields(strings.ToLower(strings.ReplaceAll(t, "_", " "))), " ")
			if _, ok := p.dish[t]; ok {
				continue
			}
			p.dish[t] = d
			n := len(strings.Fields(t))
			if n > p.maxLen {
				p.maxLen = n
			}
			if n == 1 && len(t) >= p.r.FuzzyMinLen {
				p.single = append(p.single, t)
			}
		}
	}
	for u, ur := range p.r.Units {
		for _, w := range ur.Words {
			p.unitOf[w] = u
		}
	}
	for lvl, ws := range p.r.OilWords {
		for _, w := range ws {
			p.oilOf[w] = lvl
		}
	}
	p.small, p.oilNoun, p.filler, p.fat = set(p.r.SmallWords), set(p.r.OilNouns), set(p.r.Fillers), set(p.r.FatDishes)
	return p, nil
}

func set(xs []string) map[string]bool {
	m := map[string]bool{}
	for _, x := range xs {
		m[x] = true
	}
	return m
}

var (
	reNumUnit = regexp.MustCompile(`(\d+(?:\.\d+)?)([a-z]+)`) // "200g", "2roti"
	reClean   = regexp.MustCompile(`[^a-z0-9.½&+ ]+`)
	reFrac    = regexp.MustCompile(`(\d+)\s*/\s*(\d+)`)
)

func (p *Parser) normalize(s string) string {
	s = strings.ToLower(s)
	s = reFrac.ReplaceAllStringFunc(s, func(m string) string {
		x := reFrac.FindStringSubmatch(m)
		a, _ := strconv.ParseFloat(x[1], 64)
		b, _ := strconv.ParseFloat(x[2], 64)
		if b == 0 {
			return m
		}
		return strconv.FormatFloat(a/b, 'f', -1, 64)
	})
	s = strings.ReplaceAll(s, "½", " 0.5 ")
	s = reClean.ReplaceAllString(s, " , ")
	s = strings.ReplaceAll(s, "&", " & ")
	s = strings.ReplaceAll(s, "+", " + ")
	s = reNumUnit.ReplaceAllString(s, "$1 $2")
	s = " " + strings.Join(strings.Fields(s), " ") + " "
	// "1 and half" -> "1.5"; "and half" after a number word handled too.
	for _, suf := range p.r.HalfSuffixes {
		s = strings.ReplaceAll(s, " "+suf+" ", " +0.5 ")
	}
	return s
}

type token struct {
	w   string
	num float64
	isN bool
	sep bool
}

func (p *Parser) tokenize(s string) []token {
	var out []token
	for _, f := range strings.Fields(p.normalize(s)) {
		if f == "," || f == "." {
			out = append(out, token{sep: true})
			continue
		}
		f = strings.Trim(f, ".")
		if f == "" {
			continue
		}
		if f == "+0.5" {
			if n := len(out); n > 0 && out[n-1].isN {
				out[n-1].num += 0.5
			} else {
				out = append(out, token{num: 1.5, isN: true}) // "maggi and half" == 1.5
			}
			continue
		}
		if v, err := strconv.ParseFloat(f, 64); err == nil {
			out = append(out, token{num: v, isN: true})
			continue
		}
		if v, ok := p.r.Numbers[f]; ok {
			// "a"/"an"/"do"/"no" double as words; only treat as numbers when followed by something.
			out = append(out, token{w: f, num: v, isN: true})
			continue
		}
		out = append(out, token{w: f})
	}
	return out
}

func (t token) word() string {
	if t.w != "" {
		return t.w
	}
	return strconv.FormatFloat(t.num, 'f', -1, 64)
}

// matchDish tries the longest dish term starting at i. Returns dish, length, fuzzy.
func (p *Parser) matchDish(toks []token, i int) (*dishes.Dish, int, bool) {
	for n := p.maxLen; n >= 1; n-- {
		if i+n > len(toks) {
			continue
		}
		ws := make([]string, 0, n)
		ok := true
		for _, t := range toks[i : i+n] {
			if t.sep || t.w == "" {
				ok = false
				break
			}
			ws = append(ws, t.w)
		}
		if !ok {
			continue
		}
		term := strings.Join(ws, " ")
		if d, ok := p.dish[term]; ok {
			return d, n, false
		}
		if n == 1 {
			for _, alt := range []string{strings.TrimSuffix(term, "s"), strings.TrimSuffix(term, "es"), strings.TrimSuffix(term, "an")} {
				if d, ok := p.dish[alt]; ok && alt != term {
					return d, 1, false
				}
			}
			if len(term) >= p.r.FuzzyMinLen {
				best, bd := "", p.r.FuzzyMaxDist+1
				for _, c := range p.single {
					if d := lev(term, c, bd); d < bd {
						best, bd = c, d
					}
				}
				if best != "" {
					return p.dish[best], 1, true
				}
			}
		}
	}
	return nil, 0, false
}

type pending struct {
	qty    float64
	hasQty bool
	unit   string
	factor float64
	oil    string
	small  bool
	words  []string
}

// Parse parses a meal description.
func (p *Parser) Parse(text string) Result {
	toks := p.tokenize(text)
	res := Result{Items: []Item{}, Unmatched: []string{}}
	var pd pending
	var unk []string
	var lastExplicit bool // last item got an explicit quantity
	flushUnk := func() {
		if len(unk) > 0 {
			res.Unmatched = append(res.Unmatched, strings.Join(unk, " "))
			unk = nil
		}
	}
	lastItem := func() *Item {
		if len(res.Items) == 0 {
			return nil
		}
		return &res.Items[len(res.Items)-1]
	}
	for i := 0; i < len(toks); i++ {
		t := toks[i]
		if t.sep {
			flushUnk()
			continue
		}
		// dish first (longest match), so "do" in a dish name etc. is not a number
		if !t.isN || t.w == "" {
			if d, n, fz := p.matchDish(toks, i); d != nil {
				flushUnk()
				matched := make([]string, n)
				for k := 0; k < n; k++ {
					matched[k] = toks[i+k].word()
				}
				it := p.build(d, pd, strings.Join(matched, " "), fz)
				res.Items = append(res.Items, it)
				lastExplicit = pd.hasQty || pd.unit != ""
				pd = pending{}
				i += n - 1
				continue
			}
		}
		if t.isN {
			// trailing quantity: "maggie 1.5", "roti 2" when the item had none and nothing quantifiable follows
			if li := lastItem(); li != nil && !lastExplicit && !pd.hasQty && p.trailing(toks, i) {
				u, f := "", 1.0
				if i+1 < len(toks) && !toks[i+1].sep {
					u, f = p.unitFor(toks[i+1].w)
					if u != "" {
						i++
					}
				}
				*li = p.rescale(li, t.num*f, u)
				lastExplicit = true
				continue
			}
			if t.w != "" && (i+1 >= len(toks) || toks[i+1].sep) {
				continue // dangling "a"/"do" word
			}
			if pd.hasQty {
				pd.qty *= t.num
			} else {
				pd.qty, pd.hasQty = t.num, true
			}
			continue
		}
		w := t.w
		if u, f := p.unitFor(w); u != "" {
			// "1 katori" / "katori" (implies 1)
			if !pd.hasQty {
				pd.qty, pd.hasQty = 1, true
			}
			pd.unit, pd.factor = u, f
			continue
		}
		if p.small[w] {
			pd.small = true
			continue
		}
		if lvl, ok := p.oilOf[w]; ok {
			// post-modifier: "dal kam oil", "sabzi extra ghee"
			if li := lastItem(); li != nil && i+1 < len(toks) && p.oilNoun[toks[i+1].w] && li.OilLevel != "" {
				*li = p.withOil(li, lvl)
				i++
				continue
			}
			pd.oil = lvl
			continue
		}
		if p.filler[w] {
			continue
		}
		if pd.hasQty && len(unk) == 0 {
			// "2 pav": keep the quantity with the unknown text for the fallback
			unk = append(unk, strconv.FormatFloat(pd.qty, 'f', -1, 64))
		}
		pd = pending{}
		// unknown word glued to a one-word dish ("paneer tikka masala"): the dish
		// match is probably wrong, so send the whole phrase to the fallback.
		if len(unk) == 0 && !lastExplicit {
			var glued []string
			for k := i - 1; k >= 0; k-- {
				li := lastItem()
				if li == nil || toks[k].sep || li.Matched != toks[k].word() || li.Quantity != 1 {
					break
				}
				glued = append([]string{li.Matched}, glued...)
				res.Items = res.Items[:len(res.Items)-1]
				if !li.Fuzzy {
					break // only keep walking back over typo-matched words
				}
			}
			unk = append(unk, glued...)
		}
		unk = append(unk, w)
	}
	flushUnk()
	return res
}

func (p *Parser) unitFor(w string) (string, float64) {
	u, ok := p.unitOf[w]
	if !ok {
		return "", 0
	}
	ur := p.r.Units[u]
	if ur.As != "" {
		return ur.As, ur.Factor
	}
	return u, 1
}

// trailing reports whether the number at i is followed by nothing it could quantify.
func (p *Parser) trailing(toks []token, i int) bool {
	j := i + 1
	if j < len(toks) && !toks[j].sep {
		if u, _ := p.unitFor(toks[j].w); u != "" {
			j++
		}
	}
	if j >= len(toks) || toks[j].sep {
		return true
	}
	if toks[j].isN {
		return false
	}
	return p.filler[toks[j].w] && (j+1 >= len(toks) || toks[j+1].sep)
}

func (p *Parser) unitGrams(d *dishes.Dish, unit string) float64 {
	if unit == "" || unit == d.Unit {
		return d.PortionGrams
	}
	if unit == "count" {
		if d.Unit == "count" {
			return d.PortionGrams
		}
		return d.PortionGrams // "1 piece pizza" style; one standard portion
	}
	return p.r.Units[unit].Grams
}

func (p *Parser) build(d *dishes.Dish, pd pending, matched string, fuzzy bool) Item {
	qty := 1.0
	if pd.hasQty {
		qty = pd.qty * nz(pd.factor)
	}
	unit := pd.unit
	if pd.small && !pd.hasQty && !p.fat[d.ID] {
		qty = 0.5 // "thoda rice"
	}
	if p.fat[d.ID] && !pd.hasQty {
		qty = p.r.DefaultFatSpoon
		if pd.small || pd.oil == "less" {
			qty = p.r.SmallFatSpoons
		}
		if pd.oil == "extra" {
			qty = p.r.ExtraFatSpoons
		}
	}
	it := Item{DishID: d.ID, Name: d.Name, Matched: matched, Source: d.Source, SourceNote: d.SourceNote, Fuzzy: fuzzy}
	it = p.compute(d, it, qty, unit)
	if d.OilSensitive {
		lvl := pd.oil
		if lvl == "" {
			lvl = "normal"
		}
		it = p.withOil(&it, lvl)
	}
	return it
}

func nz(f float64) float64 {
	if f == 0 {
		return 1
	}
	return f
}

func (p *Parser) dishByID(id string) *dishes.Dish { return p.byID[id] }

func (p *Parser) compute(d *dishes.Dish, it Item, qty float64, unit string) Item {
	if unit == "" {
		unit = d.Unit
	}
	grams := qty * p.unitGrams(d, unit)
	if unit == "gram" {
		grams = qty
	}
	scale := grams / d.PortionGrams
	it.Quantity, it.Unit, it.Grams = round(qty, 2), unit, round(grams, 0)
	it.Kcal = Range{round(d.KcalLow*scale, 0), round(d.Kcal*scale, 0), round(d.KcalHigh*scale, 0)}
	it.Protein = Range{round(d.ProteinLow*scale, 1), round(d.ProteinG*scale, 1), round(d.ProteinHigh*scale, 1)}
	return it
}

func (p *Parser) rescale(it *Item, qty float64, unit string) Item {
	d := p.dishByID(it.DishID)
	lvl := it.OilLevel
	n := p.compute(d, *it, qty, unit)
	n.OilLevel = ""
	if lvl != "" {
		n = p.withOil(&n, lvl)
	}
	return n
}

// withOil sets the oil level and shifts the kcal range for oil-sensitive dishes.
func (p *Parser) withOil(it *Item, lvl string) Item {
	d := p.dishByID(it.DishID)
	n := p.compute(d, *it, it.Quantity, it.Unit)
	n.OilLevel = lvl
	delta := p.r.OilKcalPer150g * n.Grams / 150
	switch lvl {
	case "less":
		n.Kcal = Range{math.Max(0, round(n.Kcal.Low-delta, 0)), math.Max(0, round(n.Kcal.Best-delta, 0)), n.Kcal.High - round(delta/2, 0)}
	case "extra":
		n.Kcal = Range{n.Kcal.Low + round(delta/2, 0), round(n.Kcal.Best+delta, 0), round(n.Kcal.High+delta*1.5, 0)}
	}
	return n
}

func round(f float64, d int) float64 {
	m := math.Pow(10, float64(d))
	return math.Round(f*m) / m
}

// lev is Levenshtein distance with an early exit above max.
func lev(a, b string, max int) int {
	if d := len(a) - len(b); d > max || -d > max {
		return max + 1
	}
	prev := make([]int, len(b)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(a); i++ {
		cur := make([]int, len(b)+1)
		cur[0] = i
		lo := cur[0]
		for j := 1; j <= len(b); j++ {
			c := 1
			if a[i-1] == b[j-1] {
				c = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+c)
			lo = min(lo, cur[j])
		}
		if lo > max {
			return max + 1
		}
		prev = cur
	}
	return prev[len(b)]
}

// Totals sums items.
func Totals(items []Item) (Range, Range) {
	var k, pr Range
	for _, it := range items {
		k.Low += it.Kcal.Low
		k.Best += it.Kcal.Best
		k.High += it.Kcal.High
		pr.Low += it.Protein.Low
		pr.Best += it.Protein.Best
		pr.High += it.Protein.High
	}
	pr = Range{round(pr.Low, 1), round(pr.Best, 1), round(pr.High, 1)}
	return k, pr
}

// ErrUnknownDish is returned by Recompute for ids not in the table.
var ErrUnknownDish = errors.New("unknown dish_id")

// Units lists the units an item can be expressed in.
var Units = map[string]bool{"count": true, "katori": true, "spoon": true, "plate": true, "glass": true, "gram": true}

// Recompute builds an item from an edited chip (dish, quantity, unit, oil level).
func (p *Parser) Recompute(dishID string, qty float64, unit, oil string) (Item, error) {
	d := p.dishByID(dishID)
	if d == nil {
		return Item{}, ErrUnknownDish
	}
	if unit != "" && !Units[unit] {
		return Item{}, errors.New("unit must be one of count, katori, spoon, plate, glass, gram")
	}
	if qty <= 0 || qty > 5000 {
		return Item{}, errors.New("quantity out of range")
	}
	it := Item{DishID: d.ID, Name: d.Name, Matched: d.Name, Source: d.Source, SourceNote: d.SourceNote}
	it = p.compute(d, it, qty, unit)
	if d.OilSensitive {
		if oil == "" {
			oil = "normal"
		}
		if oil != "less" && oil != "normal" && oil != "extra" {
			return Item{}, errors.New("oil_level must be less, normal or extra")
		}
		it = p.withOil(&it, oil)
	}
	return it, nil
}

// Dish returns a table row by id.
func (p *Parser) Dish(id string) (dishes.Dish, bool) {
	if d := p.dishByID(id); d != nil {
		return *d, true
	}
	return dishes.Dish{}, false
}

// Table returns the dish table (for GET /v1/dishes and the coach).
func (p *Parser) Table() []dishes.Dish { return p.table }
