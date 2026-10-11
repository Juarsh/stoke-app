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

// Rules is the data-driven vocabulary (see rules.json).
type Rules struct {
	Numbers         map[string]float64  `json:"numbers"`
	HalfSuffixes    []string            `json:"half_suffixes"`
	Units           map[string]unitRule `json:"units"`
	OilWords        map[string][]string `json:"oil_words"`
	OilNouns        []string            `json:"oil_nouns"`
	OilSuffixes     []string            `json:"oil_suffixes"`
	SmallWords      []string            `json:"small_words"`
	FatDishes       []string            `json:"fat_dishes"`
	SmallFatSpoons  float64             `json:"small_fat_spoons"`
	DefaultFatSpoon float64             `json:"default_fat_spoons"`
	ExtraFatSpoons  float64             `json:"extra_fat_spoons"`
	MaxFatSpoons    float64             `json:"max_fat_spoons"`
	OilKcalPer150g  float64             `json:"oil_kcal_per_150g"`
	Fillers         []string            `json:"fillers"`
	BrandWords      []string            `json:"brand_words"`
	MultPrefixes    []string            `json:"multiplier_prefixes"`
	ProteinWords    map[string]string   `json:"protein_words"`
	GenitiveWords   []string            `json:"genitive_words"`
	FuzzyMinLen     int                 `json:"fuzzy_min_len"`
	FuzzyMaxDist    int                 `json:"fuzzy_max_dist"`
	FuzzyFirst      bool                `json:"fuzzy_same_first_letter"`
	DevDigits       string              `json:"devanagari_digits"`
	DevWords        map[string]string   `json:"devanagari_words"`
	GenericProtein  map[string]string   `json:"generic_protein_dish"`
	FormWords       []string            `json:"form_words"`
	ModifierWords   []string            `json:"modifier_words"`
	StuffingWords   []string            `json:"stuffing_words"`
	Connectors      []string            `json:"connectors"`
	EggWords        []string            `json:"egg_words"`
	EggsPerPortion  map[string]float64  `json:"eggs_per_portion"`
	FuzzyMinSim     float64             `json:"fuzzy_min_similarity"`
	UnknownItem     struct {
		Kcal     [3]float64 `json:"kcal"`
		ProteinG [3]float64 `json:"protein_g"`
		Name     string     `json:"name"`
	} `json:"unknown_item"`
	Sanity struct {
		MaxItemKcal float64 `json:"max_item_kcal"`
		MaxMultiple float64 `json:"max_portion_multiple"`
	} `json:"sanity"`
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
	Unit       string  `json:"unit"` // count, piece, katori, spoon, plate, glass, gram
	Grams      float64 `json:"grams"`
	OilLevel   string  `json:"oil_level"` // less, normal, extra ("" when the dish has no cooking oil)
	Kcal       Range   `json:"kcal"`
	Protein    Range   `json:"protein_g"`
	CarbsG     float64 `json:"carbs_g"`     // estimate
	FatG       float64 `json:"fat_g"`       // estimate
	Source     string  `json:"source"`      // table | did_you_mean | generic | ai_estimate
	DataSource string  `json:"data_source"` // where the numbers come from: estimate | usda_fdc | open_food_facts | ai
	SourceNote string  `json:"source_note"`
	Fuzzy      bool    `json:"fuzzy"`
	FromCombo  string  `json:"from_combo,omitempty"` // set when a combo dish was split into parts
	// NeedsConfirm flags implausible amounts (over max_item_kcal or more than
	// max_portion_multiple standard portions); Alternatives offers readings
	// such as pieces instead of plates.
	NeedsConfirmation bool          `json:"needs_confirmation"`
	Alternatives      []Alternative `json:"alternatives,omitempty"`
	AIEstimate        bool          `json:"ai_estimate"`

	explicit bool // quantity/unit came from the text
	generic  bool
	clause   int  // comma-separated part of the text
	joined   bool // linked to the previous item by "with"/"aur"
}

// Response sources. Only confident table matches skip confirmation.
const (
	SourceTable      = "table"
	SourceDidYouMean = "did_you_mean"
	SourceGeneric    = "generic"
	SourceAI         = "ai_estimate"
)

// Alternative is another reading of an implausible item.
type Alternative struct {
	Quantity float64 `json:"quantity"`
	Unit     string  `json:"unit"`
	Kcal     float64 `json:"kcal"`
	Label    string  `json:"label"`
}

// Result is a parsed meal.
type Result struct {
	Items     []Item   `json:"items"`
	Unmatched []string `json:"unmatched"`
}

type Parser struct {
	r         Rules
	dish      map[string]*dishes.Dish // term -> dish
	byID      map[string]*dishes.Dish
	table     []dishes.Dish
	maxLen    int
	byWords   map[int][]string // n-word terms, for fuzzy
	unitOf    map[string]string
	oilOf     map[string]string
	small     map[string]bool
	oilNoun   map[string]bool
	oilSuf    map[string]bool
	filler    map[string]bool
	fat       map[string]bool
	genitive  map[string]bool
	formWord  map[string]bool
	modifier  map[string]bool
	stuffing  map[string]bool
	connector map[string]bool
	eggWord   map[string]bool
	devDigit  map[rune]rune
	reMult    *regexp.Regexp
}

// New builds a parser from the embedded rules and the given dish table.
func New(ds []dishes.Dish) (*Parser, error) {
	p := &Parser{dish: map[string]*dishes.Dish{}, byID: map[string]*dishes.Dish{}, table: ds,
		byWords: map[int][]string{}, unitOf: map[string]string{}, oilOf: map[string]string{}, devDigit: map[rune]rune{}}
	if err := json.Unmarshal(rulesJSON, &p.r); err != nil {
		return nil, err
	}
	for i := range ds {
		d := &ds[i]
		p.byID[d.ID] = d
		for _, t := range append([]string{d.Name, strings.ReplaceAll(d.ID, "_", " ")}, d.Aliases...) {
			t = strings.Join(strings.Fields(strings.ToLower(t)), " ")
			if _, ok := p.dish[t]; ok || t == "" {
				continue
			}
			p.dish[t] = d
			n := len(strings.Fields(t))
			p.maxLen = max(p.maxLen, n)
			p.byWords[n] = append(p.byWords[n], t)
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
	for i, r := range []rune(p.r.DevDigits) {
		p.devDigit[r] = rune('0' + i)
	}
	p.small, p.oilNoun, p.oilSuf, p.fat, p.genitive = set(p.r.SmallWords), set(p.r.OilNouns), set(p.r.OilSuffixes), set(p.r.FatDishes), set(p.r.GenitiveWords)
	p.formWord, p.modifier, p.stuffing, p.connector, p.eggWord = set(p.r.FormWords), set(p.r.ModifierWords), set(p.r.StuffingWords), set(p.r.Connectors), set(p.r.EggWords)
	p.filler = set(append(append([]string{}, p.r.Fillers...), p.r.BrandWords...))
	pre := make([]string, len(p.r.MultPrefixes))
	for i, m := range p.r.MultPrefixes {
		pre[i] = regexp.QuoteMeta(m)
	}
	p.reMult = regexp.MustCompile(`(?:^|\s)(?:` + strings.Join(pre, "|") + `)\s*(\d+(?:\.\d+)?)(?:\s|$)|(?:^|\s)(\d+(?:\.\d+)?)\s*(?:x|×)(?:\s|$)`)
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
	reClean   = regexp.MustCompile(`[^a-z0-9.½&+*\x{0900}-\x{097F} ]+`)
	reFrac    = regexp.MustCompile(`(\d+)\s*/\s*(\d+)`)
	reDevWord = regexp.MustCompile(`[\x{0900}-\x{097F}]+`)
)

// transliterate maps Devanagari digits and known Devanagari words to the
// Latin spellings the table uses; unknown Devanagari words stay as they are
// (and end up in "unmatched").
func (p *Parser) transliterate(s string) string {
	s = strings.Map(func(r rune) rune {
		if d, ok := p.devDigit[r]; ok {
			return d
		}
		if r == '\u093C' { // nukta: compare without it
			return -1
		}
		return r
	}, s)
	return reDevWord.ReplaceAllStringFunc(s, func(w string) string {
		if t, ok := p.devWord(w); ok {
			return " " + t + " "
		}
		return " " + w + " "
	})
}

func (p *Parser) devWord(w string) (string, bool) {
	for k, v := range p.r.DevWords {
		if strings.ReplaceAll(k, "\u093C", "") == w {
			return v, true
		}
	}
	return "", false
}

func (p *Parser) normalize(s string) string {
	s = strings.ToLower(p.transliterate(s))
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
	// "x2", "× 2", "2x" -> multiplier token "*2"
	for i := 0; i < 2; i++ { // twice for adjacent matches
		s = p.reMult.ReplaceAllStringFunc(s, func(m string) string {
			x := p.reMult.FindStringSubmatch(m)
			return " *" + x[1] + x[2] + " "
		})
	}
	s = reClean.ReplaceAllString(s, " , ")
	s = strings.ReplaceAll(s, "&", " & ")
	s = strings.ReplaceAll(s, "+", " + ")
	s = reNumUnit.ReplaceAllString(s, "$1 $2")
	s = " " + strings.Join(strings.Fields(s), " ") + " "
	for _, suf := range p.r.HalfSuffixes {
		s = strings.ReplaceAll(s, " "+suf+" ", " +0.5 ")
	}
	return s
}

type token struct {
	w    string
	num  float64
	isN  bool
	sep  bool
	mult float64 // "*2"
}

func (p *Parser) tokenize(s string) []token {
	var out []token
	for _, f := range strings.Fields(p.normalize(s)) {
		if f == "," || f == "." {
			out = append(out, token{sep: true})
			continue
		}
		if m, ok := strings.CutPrefix(f, "*"); ok {
			if v, err := strconv.ParseFloat(m, 64); err == nil && v > 0 {
				out = append(out, token{mult: v})
			}
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
			out = append(out, token{w: f, num: v, isN: true})
			continue
		}
		out = append(out, token{w: f})
	}
	// "aloo ki sabzi" -> "aloo sabzi" when that is a dish
	for i := 1; i+1 < len(out); i++ {
		if p.genitive[out[i].w] && out[i-1].w != "" && out[i+1].w != "" {
			if _, ok := p.dish[out[i-1].w+" "+out[i+1].w]; ok {
				out = append(out[:i], out[i+1:]...)
			}
		}
	}
	return out
}

func (t token) word() string {
	if t.w != "" {
		return t.w
	}
	return strconv.FormatFloat(t.num, 'f', -1, 64)
}

func (p *Parser) words(toks []token, i, n int) ([]string, bool) {
	if i+n > len(toks) {
		return nil, false
	}
	ws := make([]string, 0, n)
	for _, t := range toks[i : i+n] {
		if t.sep || t.w == "" || t.mult != 0 {
			return nil, false
		}
		ws = append(ws, t.w)
	}
	return ws, true
}

// fuzzyWord: one word within the typo budget of another.
func (p *Parser) fuzzyWord(a, b string) bool {
	if a == b {
		return true
	}
	if len([]rune(a)) < p.r.FuzzyMinLen || len([]rune(b)) < p.r.FuzzyMinLen {
		return false
	}
	if p.r.FuzzyFirst && a[0] != b[0] {
		return false
	}
	la, lb := len([]rune(a)), len([]rune(b))
	if la-lb > 1 || lb-la > 1 {
		return false
	}
	// protein / ingredient words are never "corrected" into something else
	if ka, ok := p.r.ProteinWords[a]; ok && ka != p.r.ProteinWords[b] {
		return false
	}
	d := lev(a, b, p.r.FuzzyMaxDist)
	return d <= p.r.FuzzyMaxDist && 1-float64(d)/float64(max(la, lb)) >= p.r.FuzzyMinSim
}

// matchDish tries, longest first, an exact term and then a typo-tolerant
// one of the same length, so "chiken biryani" matches "chicken biryani"
// before "chiken" alone can match "chicken".
func (p *Parser) matchDish(toks []token, i int) (*dishes.Dish, int, bool) {
	for n := p.maxLen; n >= 1; n-- {
		ws, ok := p.words(toks, i, n)
		if !ok {
			continue
		}
		term := strings.Join(ws, " ")
		if d, ok := p.dish[term]; ok {
			return d, n, false
		}
		// plural on the last word: "rotis", "naans", "idlies"
		last := ws[n-1]
		for _, suf := range []string{"s", "es"} {
			if alt, ok := strings.CutSuffix(last, suf); ok && alt != "" {
				if d, ok := p.dish[strings.Join(append(ws[:n-1:n-1], alt), " ")]; ok {
					return d, n, false
				}
			}
		}
		if p.filler[term] || p.unitOf[term] != "" || p.oilOf[term] != "" || p.small[term] {
			continue
		}
		best, bestD := "", 1<<30
		for _, c := range p.byWords[n] {
			cw := strings.Fields(c)
			ok, dist := true, 0
			for k := range cw {
				if !p.fuzzyWord(ws[k], cw[k]) {
					ok = false
					break
				}
				dist += lev(ws[k], cw[k], 3)
			}
			if ok && (dist < bestD || dist == bestD && c < best) {
				best, bestD = c, dist
			}
		}
		if best != "" {
			return p.dish[best], n, true
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
}

// Parse parses a meal description.
func (p *Parser) Parse(text string) Result {
	toks := p.tokenize(text)
	res := Result{Items: []Item{}, Unmatched: []string{}}
	var pd pending
	var unk []string
	clause := 0
	joined := false // a connector ("with", "aur") since the last item
	flushUnk := func() {
		if len(unk) == 0 {
			return
		}
		span := strings.Join(unk, " ")
		unk = nil
		if it, ok := p.genericProtein(span, clause); ok {
			res.Items = append(res.Items, it)
			return
		}
		res.Unmatched = append(res.Unmatched, span)
	}
	last := func() *Item { return lastItem(&res) }
	push := func(items []Item) {
		for k := range items {
			items[k].clause = clause
			items[k].joined = joined && len(res.Items) > 0 && res.Items[len(res.Items)-1].clause == clause
		}
		res.Items = append(res.Items, items...)
		joined = false
	}
	for i := 0; i < len(toks); i++ {
		t := toks[i]
		if t.sep {
			flushUnk()
			clause++
			joined = false
			continue
		}
		if t.mult != 0 {
			// "vada pav x2": multiply the last dish (all parts of a split combo)
			if li := last(); li != nil {
				for k := len(res.Items) - 1; k >= 0; k-- {
					it := &res.Items[k]
					*it = p.rescale(it, it.Quantity*t.mult, it.Unit)
					it.explicit = true
					if li.FromCombo == "" || it.FromCombo != li.FromCombo || it.Matched != li.Matched {
						break
					}
				}
			} else {
				pd.qty, pd.hasQty = t.mult, true
			}
			continue
		}
		if _, ok := p.r.ProteinWords[t.w]; ok && p.attachProtein(t.w, &res) {
			continue // already folded into the last item ("momos chicken")
		}
		// a form word after a bare protein ("paneer tikka masala", "chicken roll")
		if p.formWord[t.w] && p.dish[t.w] == nil {
			if li := last(); li != nil && !li.explicit && p.isProteinWord(li.Matched) && li.FromCombo == "" {
				span := li.Matched + " " + t.w
				for i+1 < len(toks) && (p.formWord[toks[i+1].w]) {
					i++
					span += " " + toks[i].w
				}
				if g, ok := p.genericProtein(span, li.clause); ok {
					g.Quantity, g.explicit = li.Quantity, li.explicit
					res.Items[len(res.Items)-1] = g
					continue
				}
			}
			if li := last(); li != nil && li.clause == clause && len(unk) == 0 {
				continue // "chicken tikka masala": a form word after a full dish adds nothing
			}
		}
		if !t.isN || t.w == "" {
			if d, n, fz := p.matchDish(toks, i); d != nil {
				matched := make([]string, n)
				for k := 0; k < n; k++ {
					matched[k] = toks[i+k].word()
				}
				// "ghee wala" right after an oily dish: extra oil on that dish
				if p.fat[d.ID] && i+n < len(toks) && p.oilSuf[toks[i+n].w] {
					flushUnk()
					if li := last(); li != nil && li.OilLevel != "" {
						*li = p.withOil(li, "extra")
					} else {
						pd.oil = "extra"
					}
					i += n
					continue
				}
				// "do ande ka omelette": the egg count belongs to the egg dish
				if p.eggWord[strings.Join(matched, " ")] {
					if j, ed := p.eggDishAhead(toks, i+n); ed != nil {
						flushUnk()
						eggs := 1.0
						if pd.hasQty {
							eggs = pd.qty * nz(pd.factor)
						}
						pd = pending{qty: eggs / p.r.EggsPerPortion[ed.ID], hasQty: true, oil: pd.oil}
						its := p.build(ed, pd, strings.Join(wordsOf(toks[i:j+1]), " "), false)
						push(its)
						pd = pending{}
						i = j
						continue
					}
				}
				// variant from a modifier word before it ("aloo bhara paratha", "veg momos")
				if v, ok := p.variantFromUnk(d, unk); ok {
					d = v
					unk = unk[:len(unk)-1]
				}
				flushUnk()
				d = p.proteinVariant(d, toks, i, n, &res)
				var skip int
				d, skip = p.variantAhead(d, toks, i+n)
				items := p.build(d, pd, strings.Join(matched, " "), fz)
				push(items)
				pd = pending{}
				i += n - 1 + skip
				continue
			}
		}
		if t.isN {
			// "omelette 2 egg ka": egg count for the egg dish before it
			if li := last(); li != nil && !li.explicit && p.r.EggsPerPortion[li.DishID] > 0 && i+1 < len(toks) && p.eggWord[toks[i+1].w] {
				*li = p.rescale(li, t.num/p.r.EggsPerPortion[li.DishID], li.Unit)
				li.explicit = true
				i++
				for i+1 < len(toks) && (p.genitive[toks[i+1].w] || p.oilSuf[toks[i+1].w]) {
					i++
				}
				continue
			}
			// trailing quantity: "maggie 1.5", "khichdi with ghee 1 bowl"
			if tgt := p.trailTarget(&res); tgt >= 0 && !pd.hasQty && (p.trailing(toks, i) || p.countBetween(&res, tgt, toks, i)) {
				u, f := "", 1.0
				if i+1 < len(toks) && !toks[i+1].sep {
					if uu, ff := p.unitFor(toks[i+1].w); uu != "" {
						u, f = uu, ff
						i++
					}
				}
				p.applyTrailing(&res, tgt, t.num*f, u)
				continue
			}
			if t.w != "" && (i+1 >= len(toks) || toks[i+1].sep) {
				continue // dangling "a"/"do"
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
			// post-modifier "dal kam oil": change that dish ("zyada ghee" adds a ghee item)
			if li := last(); li != nil && lvl != "extra" && i+1 < len(toks) && p.oilNoun[toks[i+1].w] && li.OilLevel != "" {
				*li = p.withOil(li, lvl)
				i++
				continue
			}
			pd.oil = lvl
			continue
		}
		if p.oilNoun[w] && i+1 < len(toks) && p.oilSuf[toks[i+1].w] {
			if li := last(); li != nil && li.OilLevel != "" {
				*li = p.withOil(li, "extra")
			} else {
				pd.oil = "extra"
			}
			i++
			continue
		}
		if p.connector[w] {
			flushUnk()
			joined = true
			continue
		}
		if p.filler[w] || p.oilSuf[w] || p.genitive[w] || p.stuffing[w] {
			continue
		}
		if pd.hasQty && len(unk) == 0 {
			unk = append(unk, strconv.FormatFloat(pd.qty, 'f', -1, 64))
		}
		pd = pending{}
		// unknown word glued to a one-word dish ("paneer tikka masala"): the
		// dish match is probably wrong, so the phrase goes on as one span.
		if len(unk) == 0 {
			var glued []string
			for k := i - 1; k >= 0; k-- {
				li := last()
				if li == nil || li.explicit || toks[k].sep || li.Matched != toks[k].word() || li.FromCombo != "" {
					break
				}
				glued = append([]string{li.Matched}, glued...)
				res.Items = res.Items[:len(res.Items)-1]
				if !li.Fuzzy {
					break
				}
			}
			unk = append(unk, glued...)
		}
		unk = append(unk, w)
	}
	flushUnk()
	for i := range res.Items {
		res.Items[i].explicit = false
		p.finish(&res.Items[i])
	}
	return res
}

func wordsOf(ts []token) []string {
	var out []string
	for _, t := range ts {
		if !t.sep {
			out = append(out, t.word())
		}
	}
	return out
}

func (p *Parser) isProteinWord(s string) bool {
	_, ok := p.r.ProteinWords[s]
	return ok
}

// genericProtein turns an unknown span that mentions a protein ("paneer
// lababdar", "soya chaap roll") into a wide-range generic item.
func (p *Parser) genericProtein(span string, clause int) (Item, bool) {
	ws := strings.Fields(span)
	qty := 1.0
	if v, err := strconv.ParseFloat(ws[0], 64); err == nil && v > 0 {
		qty, ws = v, ws[1:]
	}
	for _, w := range ws {
		if kind, ok := p.r.ProteinWords[w]; ok {
			d := p.dishByID(p.r.GenericProtein[kind])
			if d == nil {
				return Item{}, false
			}
			it := Item{DishID: d.ID, Name: d.Name, Matched: span, DataSource: d.Source, SourceNote: d.SourceNote, generic: true, clause: clause}
			return p.compute(d, it, qty, ""), true
		}
	}
	return Item{}, false
}

// variantFromUnk: the unknown word just before a dish is a modifier with its
// own row ("aloo bhara paratha" -> aloo paratha, "veg momos").
func (p *Parser) variantFromUnk(d *dishes.Dish, unk []string) (*dishes.Dish, bool) {
	if len(unk) == 0 {
		return nil, false
	}
	w := unk[len(unk)-1]
	for _, name := range append([]string{d.Name}, d.Aliases...) {
		fs := strings.Fields(name)
		for _, base := range []string{name, fs[len(fs)-1]} { // "aloo" + "stuffed paratha" -> "aloo paratha"
			if v, ok := p.dish[w+" "+base]; ok && v != d {
				return v, true
			}
		}
	}
	return nil, false
}

// variantAhead: "paratha with aloo filling", "paratha aloo wala",
// "momos veg wale". Needs a stuffing word (filling, stuffed, wala...) or a
// modifier word, so "paratha aur aloo sabzi" is left alone.
func (p *Parser) variantAhead(d *dishes.Dish, toks []token, j int) (*dishes.Dish, int) {
	var cand string
	stuffed := false
	k := j
	for ; k < len(toks) && k < j+4 && !toks[k].sep && !toks[k].isN; k++ {
		w := toks[k].w
		switch {
		case p.stuffing[w] || p.genitive[w]:
			if w != "with" {
				stuffed = true
			}
		case cand == "":
			cand = w
		default:
			k = len(toks) + 1
		}
		if k > len(toks) {
			break
		}
		if cand != "" && stuffed {
			break
		}
	}
	if cand == "" || k > len(toks) {
		return d, 0
	}
	if !stuffed && !p.modifier[cand] {
		return d, 0
	}
	for _, name := range append([]string{d.Name}, d.Aliases...) {
		if v, ok := p.dish[cand+" "+name]; ok && v != d {
			// consume through the stuffing words that follow
			e := k
			if e >= len(toks) {
				e = len(toks) - 1
			}
			for e+1 < len(toks) && (p.stuffing[toks[e+1].w] || p.genitive[toks[e+1].w]) && toks[e+1].w != "with" {
				e++
			}
			return v, e - j + 1
		}
	}
	return d, 0
}

// eggDishAhead finds an egg dish right after an egg count ("2 ande ka omelette").
func (p *Parser) eggDishAhead(toks []token, j int) (int, *dishes.Dish) {
	for j < len(toks) && !toks[j].sep && (p.genitive[toks[j].w] || p.oilSuf[toks[j].w] || p.filler[toks[j].w]) {
		j++
	}
	if j >= len(toks) || toks[j].sep {
		return 0, nil
	}
	d, n, _ := p.matchDish(toks, j)
	if d == nil || p.r.EggsPerPortion[d.ID] == 0 {
		return 0, nil
	}
	return j + n - 1, d
}

// finish sets the response source and needs_confirmation.
func (p *Parser) finish(it *Item) {
	d := p.dishByID(it.DishID)
	switch {
	case it.generic || (d != nil && d.NeedsConfirm):
		it.Source = SourceGeneric
	case it.Fuzzy:
		it.Source = SourceDidYouMean
	default:
		it.Source = SourceTable
	}
	p.sanity(it)
	it.NeedsConfirmation = it.Source != SourceTable || it.NeedsConfirmation
}

func (p *Parser) sanity(it *Item) {
	d := p.dishByID(it.DishID)
	if d == nil || (it.Kcal.Best <= p.r.Sanity.MaxItemKcal && it.Grams <= p.r.Sanity.MaxMultiple*d.PortionGrams) {
		return
	}
	it.NeedsConfirmation = true
	alt := func(q float64, u, label string) {
		c := p.compute(d, Item{}, q, u)
		it.Alternatives = append(it.Alternatives, Alternative{Quantity: q, Unit: c.Unit, Kcal: c.Kcal.Best, Label: label})
	}
	if d.PieceGrams > 0 && it.Unit != "piece" {
		alt(it.Quantity, "piece", "pieces instead of "+it.Unit)
	}
	alt(1, d.Unit, "one standard portion")
}

// proteinVariant: "chicken momos" / "chicken steamed momos" / "momos chicken"
// use the "<protein> <dish>" row when the table has one. A protein word
// matched on its own just before (e.g. "chicken" -> chicken curry) is folded in.
func (p *Parser) proteinVariant(d *dishes.Dish, toks []token, i, n int, res *Result) *dishes.Dish {
	try := func(w string) *dishes.Dish {
		if _, ok := p.r.ProteinWords[w]; !ok {
			return nil
		}
		for _, name := range append([]string{d.Name}, d.Aliases...) {
			if v, ok := p.dish[w+" "+name]; ok && v != d {
				return v
			}
		}
		return nil
	}
	// look back over fillers to the previous item / word
	for k := i - 1; k >= 0 && !toks[k].sep; k-- {
		w := toks[k].w
		if p.filler[w] {
			continue
		}
		if v := try(w); v != nil {
			if li := lastItem(res); li != nil && li.Matched == w && !li.explicit {
				res.Items = res.Items[:len(res.Items)-1]
			}
			return v
		}
		break
	}
	// look ahead: "momos chicken"
	j := i + n
	for j < len(toks) && !toks[j].sep && p.filler[toks[j].w] {
		j++
	}
	if j < len(toks) && !toks[j].sep {
		if _, ok := p.r.ProteinWords[toks[j].w]; ok {
			if v := try(toks[j].w); v != nil {
				return v
			}
		}
	}
	return d
}

// attachProtein consumes a trailing protein word already folded into the
// last item ("momos chicken" -> chicken momos).
func (p *Parser) attachProtein(w string, res *Result) bool {
	li := lastItem(res)
	if li == nil {
		return false
	}
	return strings.HasPrefix(li.DishID, p.r.ProteinWords[w]+"_") || strings.HasPrefix(li.Name, w+" ")
}

func lastItem(res *Result) *Item {
	if len(res.Items) == 0 {
		return nil
	}
	return &res.Items[len(res.Items)-1]
}

// trailTarget picks the item a trailing quantity belongs to: the last item,
// or, if that is a fat (ghee/butter/oil) with no quantity, the main dish before it.
func (p *Parser) trailTarget(res *Result) int {
	n := len(res.Items)
	if n == 0 {
		return -1
	}
	li := res.Items[n-1]
	if li.explicit {
		return -1
	}
	if p.fat[li.DishID] {
		for k := n - 2; k >= 0; k-- {
			if !p.fat[res.Items[k].DishID] {
				if res.Items[k].explicit {
					return -1
				}
				return k
			}
		}
	}
	return n - 1
}

func (p *Parser) applyTrailing(res *Result, k int, qty float64, unit string) {
	// "dal with rice, 1 bowl": one bowl shared by the dishes joined by "with"/"aur"
	if unit != "" {
		group := []int{k}
		for j := k; j > 0 && res.Items[j].joined; {
			j--
			if res.Items[j].clause != res.Items[k].clause || res.Items[j].explicit {
				break
			}
			if p.fat[res.Items[j].DishID] {
				continue
			}
			group = append(group, j)
		}
		if len(group) > 1 {
			var sum float64
			for _, g := range group {
				sum += p.dishByID(res.Items[g].DishID).PortionGrams
			}
			for _, g := range group {
				it := &res.Items[g]
				share := qty * p.dishByID(it.DishID).PortionGrams / sum
				*it = p.rescale(it, round(share, 2), unit)
				it.explicit = true
			}
			return
		}
	}
	it := &res.Items[k]
	d := p.dishByID(it.DishID)
	if it.FromCombo == "" && len(d.Parts) > 0 {
		parts := p.expand(d, qty, unit, it.OilLevel, it.Matched, it.Fuzzy)
		for i := range parts {
			parts[i].clause = it.clause
		}
		res.Items = append(res.Items[:k], append(parts, res.Items[k+1:]...)...)
		return
	}
	if unit == "" && d.PieceGrams > 0 {
		unit = "piece"
	}
	*it = p.rescale(it, qty, unit)
	it.explicit = true
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

// trailing reports whether the number at i quantifies the dish before it.
func (p *Parser) trailing(toks []token, i int) bool {
	j := i + 1
	if j < len(toks) && !toks[j].sep {
		if u, _ := p.unitFor(toks[j].w); u != "" {
			j++
		}
	}
	for j < len(toks) && !toks[j].sep && p.filler[toks[j].w] {
		j++
	}
	return j >= len(toks) || toks[j].sep
}

// countBetween: "luchi 4 aloo posto" - a bare number after a counted dish
// (roti, luchi, idli) and before a bowl/plate dish belongs to the counted one.
func (p *Parser) countBetween(res *Result, tgt int, toks []token, i int) bool {
	if i+1 >= len(toks) || toks[i+1].sep || toks[i+1].isN || p.unitOf[toks[i+1].w] != "" {
		return false
	}
	prev := p.dishByID(res.Items[tgt].DishID)
	next, _, _ := p.matchDish(toks, i+1)
	return prev != nil && next != nil && prev.Unit == "count" && next.Unit != "count" && toks[i].w == ""
}

func (p *Parser) unitGrams(d *dishes.Dish, unit string) float64 {
	switch {
	case unit == "" || unit == d.Unit || unit == "count":
		return d.PortionGrams
	case unit == "piece":
		if d.PieceGrams > 0 {
			return d.PieceGrams
		}
		return d.PortionGrams
	}
	return p.r.Units[unit].Grams
}

func (p *Parser) build(d *dishes.Dish, pd pending, matched string, fuzzy bool) []Item {
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
	oil := pd.oil
	if p.fat[d.ID] {
		oil = ""
	}
	if len(d.Parts) > 0 && (pd.hasQty || pd.unit != "") {
		return p.expand(d, qty, unit, oil, matched, fuzzy)
	}
	if d.PieceGrams > 0 && pd.hasQty && (unit == "" || unit == "count") {
		unit = "piece" // "8 momos" = 8 pieces
	}
	it := Item{DishID: d.ID, Name: d.Name, Matched: matched, DataSource: d.Source, SourceNote: d.SourceNote, Fuzzy: fuzzy, explicit: pd.hasQty}
	it = p.compute(d, it, qty, unit)
	if d.OilSensitive {
		if oil == "" {
			oil = "normal"
		}
		it = p.withOil(&it, oil)
	}
	return []Item{it}
}

// expand splits a combo ("1 plate chole bhature") into its parts, scaled by
// the portion given.
func (p *Parser) expand(d *dishes.Dish, qty float64, unit, oil, matched string, fuzzy bool) []Item {
	grams := qty * p.unitGrams(d, unit)
	if unit == "gram" {
		grams = qty
	}
	f := grams / d.PortionGrams
	var out []Item
	for _, pt := range d.Parts {
		pd := p.dishByID(pt.DishID)
		it := Item{DishID: pd.ID, Name: pd.Name, Matched: matched, DataSource: pd.Source, SourceNote: pd.SourceNote, Fuzzy: fuzzy, FromCombo: d.ID, explicit: true}
		it = p.compute(pd, it, round(pt.Qty*f, 2), pt.Unit)
		if pd.OilSensitive {
			o := oil
			if o == "" {
				o = "normal"
			}
			it = p.withOil(&it, o)
		}
		out = append(out, it)
	}
	return out
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
	if p.fat[d.ID] {
		// fats are measured in spoons; cap so a stray "1 bowl" can't become 150 g of ghee
		if unit != "spoon" && unit != "gram" {
			unit = "spoon"
		}
		if unit == "spoon" {
			qty = math.Min(qty, p.r.MaxFatSpoons)
		} else {
			qty = math.Min(qty, p.r.MaxFatSpoons*p.r.Units["spoon"].Grams)
		}
	}
	grams := qty * p.unitGrams(d, unit)
	if unit == "gram" {
		grams = qty
	}
	scale := grams / d.PortionGrams
	it.Quantity, it.Unit, it.Grams = round(qty, 2), unit, round(grams, 0)
	it.Kcal = Range{round(d.KcalLow*scale, 0), round(d.Kcal*scale, 0), round(d.KcalHigh*scale, 0)}
	it.Protein = Range{round(d.ProteinLow*scale, 1), round(d.ProteinG*scale, 1), round(d.ProteinHigh*scale, 1)}
	it.CarbsG, it.FatG = round(d.CarbsG*scale, 1), round(d.FatG*scale, 1)
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

// withOil sets the oil level and shifts kcal (and fat) for oil-sensitive dishes.
func (p *Parser) withOil(it *Item, lvl string) Item {
	d := p.dishByID(it.DishID)
	n := p.compute(d, *it, it.Quantity, it.Unit)
	n.OilLevel = lvl
	delta := p.r.OilKcalPer150g * n.Grams / 150
	switch lvl {
	case "less":
		n.Kcal = Range{math.Max(0, round(n.Kcal.Low-delta, 0)), math.Max(0, round(n.Kcal.Best-delta, 0)), n.Kcal.High - round(delta/2, 0)}
		n.FatG = math.Max(0, round(n.FatG-delta/9, 1))
	case "extra":
		n.Kcal = Range{n.Kcal.Low + round(delta/2, 0), round(n.Kcal.Best+delta, 0), round(n.Kcal.High+delta*1.5, 0)}
		n.FatG = round(n.FatG+delta/9, 1)
	}
	return n
}

func round(f float64, d int) float64 {
	m := math.Pow(10, float64(d))
	return math.Round(f*m) / m
}

// lev is Levenshtein distance (runes) with an early exit above max.
func lev(as, bs string, max int) int {
	a, b := []rune(as), []rune(bs)
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
var Units = map[string]bool{"count": true, "piece": true, "katori": true, "spoon": true, "plate": true, "glass": true, "gram": true}

// Recompute builds an item from an edited chip (dish, quantity, unit, oil level).
func (p *Parser) Recompute(dishID string, qty float64, unit, oil string) (Item, error) {
	d := p.dishByID(dishID)
	if d == nil {
		return Item{}, ErrUnknownDish
	}
	if unit != "" && !Units[unit] {
		return Item{}, errors.New("unit must be one of count, piece, katori, spoon, plate, glass, gram")
	}
	if qty <= 0 || qty > 5000 {
		return Item{}, errors.New("quantity out of range")
	}
	it := Item{DishID: d.ID, Name: d.Name, Matched: d.Name, Source: SourceTable, DataSource: d.Source, SourceNote: d.SourceNote}
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
	p.sanity(&it)
	if d.NeedsConfirm {
		it.Source, it.NeedsConfirmation = SourceGeneric, true
	}
	return it, nil
}

// Unknown is the placeholder for text nothing could estimate (no table row,
// no AI): never 0 kcal, wide range, always needs confirmation.
func (p *Parser) Unknown(span string) Item {
	u := p.r.UnknownItem
	return Item{Name: span, Matched: span, Quantity: 1, Unit: "count", Source: SourceGeneric, DataSource: "estimate",
		SourceNote: "Placeholder for unrecognised food; please confirm or enter your own numbers",
		Kcal:       Range{u.Kcal[0], u.Kcal[1], u.Kcal[2]}, Protein: Range{u.ProteinG[0], u.ProteinG[1], u.ProteinG[2]},
		NeedsConfirmation: true}
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
