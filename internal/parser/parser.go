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
	"slices"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf16"

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
	// StrictStatedQty: the table answers alone only if every span had a
	// count or unit in the text ("2 roti", "1 katori dal"); "dal" alone goes to AI.
	StrictStatedQty bool `json:"strict_require_stated_quantity"`
	// EverydayCombos: combo dish id -> its components at default portions ("_doc" ignored).
	EverydayCombos map[string]json.RawMessage `json:"everyday_combos"`
	ClaimSeps      []string                   `json:"claim_separators"`
	EverydayPairs  struct {
		CategoryPairs [][2]string `json:"category_pairs"`
		DishPairs     [][2]string `json:"dish_pairs"`
	} `json:"everyday_pairs"`
	BareCountUnits   []string                   `json:"bare_count_units"`
	UnitFits         map[string]json.RawMessage `json:"unit_fits"`
	FormWords        []string                   `json:"form_words"`
	ModifierWords    []string                   `json:"modifier_words"`
	StuffingWords    []string                   `json:"stuffing_words"`
	Connectors       []string                   `json:"connectors"`
	EggWords         []string                   `json:"egg_words"`
	EggsPerPortion   map[string]float64         `json:"eggs_per_portion"`
	EggPieceDish     string                     `json:"egg_piece_dish"`
	TableOnlyOKFlags []string                   `json:"table_only_ok_flags"`
	EggPieceBowls    []string                   `json:"egg_piece_bowls"`
	FuzzyMinSim      float64                    `json:"fuzzy_min_similarity"`
	WrapForms        []string                   `json:"wrap_forms"`
	StyleWords       []string                   `json:"style_words"`
	Stopwords        []string                   `json:"stopwords"`
	MinPlaceholder   int                        `json:"min_placeholder_len"`
	Confidence       map[string]float64         `json:"confidence"`
	FuzzyNeverCats   []string                   `json:"fuzzy_never_to_categories"`
	TypicalSides     map[string][]string        `json:"typical_sides"`
	GenericWrapDish  string                     `json:"generic_wrap_dish"`
	UnknownItem      struct {
		Kcal     [3]float64 `json:"kcal"`
		ProteinG [3]float64 `json:"protein_g"`
		Name     string     `json:"name"`
	} `json:"unknown_item"`
	Sanity struct {
		MaxItemKcal      float64 `json:"max_item_kcal"`
		MaxMultiple      float64 `json:"max_portion_multiple"`
		MaxCountMultiple float64 `json:"max_count_multiple"`
	} `json:"sanity"`
	// PlausibleMax: the largest count that makes sense in each unit for one
	// item ("8 plates momos" and "6 katori dal" exceed it -> unit_mismatch).
	PlausibleMax   map[string]float64 `json:"plausible_max"`
	NameQualifiers []string           `json:"name_qualifier_words"`
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
	NeedsConfirmation bool `json:"needs_confirmation"`
	// Confidence (0-1) from match quality and context; below the threshold
	// the item needs confirmation. Flags say why it was lowered.
	Confidence   float64       `json:"confidence"`
	Flags        []string      `json:"flags,omitempty"`
	Alternatives []Alternative `json:"alternatives,omitempty"`
	// UnitOptions: set with unit_mismatch when a count doesn't make sense in
	// the stated unit. Covers the counting-unit reading and the stated
	// reading; the item stays out of the totals until the user picks one.
	UnitOptions []UnitOption `json:"unit_options,omitempty"`
	AIEstimate  bool         `json:"ai_estimate"`
	AIName      string       `json:"ai_name,omitempty"`
	// SpanStart/SpanEnd: where this item came from in the user's original
	// text, as UTF-16 offsets (JS string indices), end exclusive.
	SpanStart int  `json:"span_start"`
	SpanEnd   int  `json:"span_end"` // the AI's own dish name; matched_text stays the user's text
	Learned   bool `json:"learned"`  // from the user's remembered readings
	// DefaultPortion: no count or unit was typed, so the dish's standard
	// portion was used ("Read as: 1 katori · Change").
	DefaultPortion bool `json:"default_portion"`

	explicit bool // quantity/unit came from the text
	stated   bool // kept after finish for TableOnly
	everyday bool // expanded from an everyday combo (allowed in TableOnly)
	generic  bool
	clause   int     // comma-separated part of the text
	joined   bool    // linked to the previous item by "with"/"aur"
	eggExtra float64 // egg pieces beyond one bowl, added by eggPieces
	pens     []string
}

func (it *Item) pen(flag string) {
	for _, f := range it.pens {
		if f == flag {
			return
		}
	}
	it.pens = append(it.pens, flag)
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

// UnitOption is one reading of an item whose count doesn't fit its unit.
type UnitOption struct {
	Quantity float64 `json:"qty"`
	Unit     string  `json:"unit"`
	Kcal     float64 `json:"kcal"`
}

// CountingUnit is the unit a bare number means for a dish: pieces for
// countable dishes (piece_grams set, or unit count), otherwise its unit.
func CountingUnit(d dishes.Dish) string {
	if d.PieceGrams > 0 {
		return "piece"
	}
	return d.Unit
}

// Result is a parsed meal.
type Result struct {
	Items     []Item   `json:"items"`
	Unmatched []string `json:"unmatched"`
	// Leftover counts words or numbers the parser could not use (including
	// short or stopword-only leftovers that never become placeholders).
	Leftover int `json:"leftover"`
}

type Parser struct {
	r          Rules
	dish       map[string]*dishes.Dish // term -> dish
	byID       map[string]*dishes.Dish
	table      []dishes.Dish
	maxLen     int
	byWords    map[int][]string // n-word terms, for fuzzy
	unitOf     map[string]string
	oilOf      map[string]string
	small      map[string]bool
	oilNoun    map[string]bool
	oilSuf     map[string]bool
	filler     map[string]bool
	fat        map[string]bool
	genitive   map[string]bool
	formWord   map[string]bool
	modifier   map[string]bool
	stuffing   map[string]bool
	connector  map[string]bool
	sep        map[string]bool
	eggWord    map[string]bool
	style      map[string]bool
	stop       map[string]bool
	noFuzzyCat map[string]bool
	devDigit   map[rune]rune
	reMult     *regexp.Regexp
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
	p.sep = set(p.r.ClaimSeps)
	p.style, p.stop, p.noFuzzyCat = set(p.r.StyleWords), set(p.r.Stopwords), set(p.r.FuzzyNeverCats)
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
			if p.noFuzzyCat[p.dish[c].Category] {
				continue // e.g. a typo never turns into a fruit
			}
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
	style  []string
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
		res.Leftover++
		if it, ok := p.genericProtein(span, clause); ok {
			res.Items = append(res.Items, it)
			return
		}
		// only real words (3+ letters, not stopwords) become a placeholder span;
		// a leading count is kept with it
		var keep []string
		for k, w := range strings.Fields(span) {
			if _, err := strconv.ParseFloat(w, 64); err == nil && k == 0 {
				keep = append(keep, w)
				continue
			}
			if len([]rune(w)) >= p.r.MinPlaceholder && !p.stop[w] {
				keep = append(keep, w)
			}
		}
		if len(keep) == 0 || (len(keep) == 1 && isNum(keep[0])) {
			return
		}
		res.Unmatched = append(res.Unmatched, strings.Join(keep, " "))
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
			if li := last(); li != nil && li.clause == clause && len(unk) == 0 && li.FromCombo == "" {
				// "soya chaap roll", "paneer tikka wrap": the form changes the dish
				if g, ok := p.applyForm(li, t.w); ok {
					res.Items[len(res.Items)-1] = g
				} else {
					li.Matched += " " + t.w // "chicken tikka masala": same dish, word kept in matched_text
				}
				continue
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
						var its []Item
						if p.eggBowl(ed) {
							its = p.eggCurry(ed, eggs, pd.oil, strings.Join(wordsOf(toks[i:j+1]), " "), false)
						} else {
							pd = pending{qty: eggs / p.r.EggsPerPortion[ed.ID], hasQty: true, oil: pd.oil}
							its = p.build(ed, pd, strings.Join(wordsOf(toks[i:j+1]), " "), false)
						}
						push(its)
						pd = pending{}
						i = j
						continue
					}
				}
				orig := d
				styleIgnored := false
				for _, st := range pd.style {
					if v, ok := p.variantFromUnk(d, []string{st}); ok {
						d = v
					} else {
						styleIgnored = true
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
				for k := range items {
					if d != orig {
						items[k].pen("variant")
					}
					if styleIgnored {
						items[k].pen("style_ignored")
					}
				}
				push(items)
				pd = pending{}
				i += n - 1 + skip
				continue
			}
		}
		if t.isN {
			// "omelette 2 egg ka": egg count for the egg dish before it
			if li := last(); li != nil && !li.explicit && p.r.EggsPerPortion[li.DishID] > 0 && i+1 < len(toks) && p.eggWord[toks[i+1].w] {
				if d := p.dishByID(li.DishID); d != nil && p.eggBowl(d) {
					its := p.eggCurry(d, t.num, li.OilLevel, li.Matched, li.Fuzzy)
					for k := range its {
						its[k].clause, its[k].joined = li.clause, li.joined
					}
					res.Items = append(res.Items[:len(res.Items)-1], its...)
					li = &res.Items[len(res.Items)-1]
				} else {
					*li = p.rescale(li, t.num/p.r.EggsPerPortion[li.DishID], li.Unit)
				}
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
				between := !p.trailing(toks, i)
				p.applyTrailing(&res, tgt, t.num*f, u)
				if k := min(tgt, len(res.Items)-1); k >= 0 {
					res.Items[k].pen("trailing_qty")
					if between {
						res.Items[k].pen("count_between")
					}
				}
				continue
			}
			if t.w != "" && (i+1 >= len(toks) || toks[i+1].sep) {
				continue // dangling "a"/"do"
			}
			if pd.hasQty {
				res.Leftover++ // two numbers in a row: one is unused
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
		if p.style[w] {
			// cooking-style words are modifiers, never items
			j := i + 1
			for j < len(toks) && p.style[toks[j].w] {
				j++
			}
			nextDish, _, _ := p.matchDish(toks, j)
			if nextDish != nil {
				pd.style = append(pd.style, w) // "steamed momos": applies to the next dish
				continue
			}
			if li := last(); nextDish == nil && li != nil && li.clause == clause && !li.explicit && p.isProteinWord(li.Matched) && li.FromCombo == "" {
				if g, ok := p.genericProtein(li.Matched+" "+w, li.clause); ok {
					res.Items[len(res.Items)-1] = g
					continue
				}
			}
			if li := last(); li != nil && li.clause == clause && len(unk) == 0 {
				if g, ok := p.applyForm(li, w); ok {
					g.pen("variant")
					res.Items[len(res.Items)-1] = g
				} else {
					li.Matched += " " + w
					li.pen("style_ignored")
				}
				continue
			}
			pd.style = append(pd.style, w)
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
		// unknown word right after a bare protein word ("paneer lababdar"):
		// the dish is unknown, so the protein goes into the span (-> generic item).
		// Other known dishes stay as they are; only the unknown part is a placeholder.
		if len(unk) == 0 {
			if li := last(); li != nil && !li.explicit && i > 0 && !toks[i-1].sep && li.Matched == toks[i-1].word() && p.isProteinWord(li.Matched) {
				unk = append(unk, li.Matched)
				res.Items = res.Items[:len(res.Items)-1]
			}
		}
		unk = append(unk, w)
	}
	flushUnk()
	if pd.hasQty {
		res.Leftover++ // a number nothing used
	}
	p.everydayCombos(&res)
	p.eggPieces(&res)
	p.tokenRules(&res, toks)
	present := map[string]bool{}
	for _, it := range res.Items {
		present[it.DishID] = true
	}
	for i := range res.Items {
		it := &res.Items[i]
		it.stated = it.explicit // a count/unit was in the text
		it.DefaultPortion = !it.stated
		it.explicit = false
		if res.Leftover > 0 || len(res.Unmatched) > 0 {
			it.pen("leftover_in_meal")
		}
		if sides, ok := p.r.TypicalSides[it.DishID]; ok {
			has := false
			for _, sd := range sides {
				has = has || present[sd]
			}
			if !has {
				it.pen("missing_side")
			}
		}
		p.finish(it)
	}
	p.assignSpans(&res, text)
	p.adjacency(&res, text)
	return res
}

func isNum(s string) bool { _, err := strconv.ParseFloat(s, 64); return err == nil }

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

// applyForm handles a form word right after a matched dish. A wrap form
// ("roll", "wrap", "frankie") looks for "<dish> roll", then "<protein> roll",
// then the generic protein dish, then a generic wrap. Other forms look for
// "<dish> <form>". ok=false means the dish stays as it is.
func (p *Parser) applyForm(li *Item, form string) (Item, bool) {
	d := p.dishByID(li.DishID)
	if d == nil {
		return Item{}, false
	}
	mk := func(nd *dishes.Dish, generic bool) (Item, bool) {
		it := Item{DishID: nd.ID, Name: nd.Name, Matched: li.Matched + " " + form, DataSource: nd.Source, SourceNote: nd.SourceNote,
			generic: generic, clause: li.clause, joined: li.joined, explicit: li.explicit, Fuzzy: li.Fuzzy}
		q, u := 1.0, ""
		if li.explicit && (li.Unit == "count" || li.Unit == "piece") {
			q = li.Quantity
		}
		if li.explicit && li.DishID == p.r.EggPieceDish && p.eggBowl(nd) {
			// "3 ande ki curry": the count is eggs, not bowls
			per := p.r.EggsPerPortion[nd.ID]
			q = math.Min(1, round(li.Quantity/per, 2))
			it.eggExtra = li.Quantity - per
			it.pen("egg_count")
		}
		return p.compute(nd, it, q, u), true
	}
	for _, name := range append([]string{d.Name}, d.Aliases...) {
		if v, ok := p.dish[name+" "+form]; ok && v != d {
			return mk(v, false)
		}
	}
	isWrap := false
	for _, w := range p.r.WrapForms {
		isWrap = isWrap || w == form
	}
	if !isWrap {
		return Item{}, false
	}
	for _, w := range strings.Fields(d.Name) {
		if kind, ok := p.r.ProteinWords[w]; ok {
			for pw, k := range p.r.ProteinWords {
				if k != kind {
					continue
				}
				if v, ok := p.dish[pw+" roll"]; ok {
					return mk(v, false)
				}
			}
			if g := p.dishByID(p.r.GenericProtein[kind]); g != nil {
				return mk(g, true)
			}
		}
	}
	if g := p.dishByID(p.r.GenericWrapDish); g != nil {
		return mk(g, true)
	}
	return Item{}, false
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
	c := 1.0
	if it.Fuzzy {
		it.pen("fuzzy")
	}
	if it.Source == SourceGeneric {
		it.pen("generic")
	}
	if it.FromCombo != "" && !it.everyday {
		it.pen("combo_or_split")
	}
	for _, f := range it.pens {
		w, ok := p.r.Confidence[f]
		if !ok {
			w = p.r.Confidence["leftover_in_meal"]
		}
		c += w
	}
	it.Confidence = math.Max(0, round(c, 2))
	if d != nil && len(it.UnitOptions) == 0 && slices.Contains(it.pens, "unit_mismatch") && it.FromCombo == "" {
		p.unitOptions(d, it) // every unit_mismatch item offers its readings
	}
	it.Flags = append([]string(nil), it.pens...)
	// leftovers, splits and combos always need a look, whatever the score
	forced := false
	for _, f := range it.pens {
		forced = forced || f == "leftover_in_meal" || f == "combo_or_split" || f == "leftover_nearby" ||
			f == "token_reuse" || f == "adjacent_split" || f == "compound_name" || f == "unit_mismatch" || f == "fractional_combo" || f == "egg_count"
	}
	if it.Confidence < p.r.Confidence["threshold"] || forced {
		it.NeedsConfirmation = true
		if it.Source == SourceTable {
			it.Source = SourceDidYouMean
		}
	}
	it.NeedsConfirmation = it.Source != SourceTable || it.NeedsConfirmation
}

func (p *Parser) sanity(it *Item) {
	d := p.dishByID(it.DishID)
	p.plausibleCount(d, it)
	mult := p.r.Sanity.MaxMultiple
	if d != nil && (d.Unit == "count" || it.Unit == "piece") {
		mult = p.r.Sanity.MaxCountMultiple // 4-6 rotis is normal
	}
	if d == nil || (it.Kcal.Best <= p.r.Sanity.MaxItemKcal && it.Grams <= mult*d.PortionGrams) {
		return
	}
	it.NeedsConfirmation = true
	it.pen("sanity")
	alt := func(q float64, u, label string) {
		c := p.compute(d, Item{}, q, u)
		it.Alternatives = append(it.Alternatives, Alternative{Quantity: q, Unit: c.Unit, Kcal: c.Kcal.Best, Label: label})
	}
	if d.PieceGrams > 0 && it.Unit != "piece" {
		alt(it.Quantity, "piece", "pieces instead of "+it.Unit)
	}
	alt(1, d.Unit, "one standard portion")
}

// plausibleCount: a typed count above rules plausible_max for its unit is
// a unit_mismatch ("8 plates momos" = 8 pieces or 8 plates?). Never guess:
// offer both readings and keep the item out of the totals.
func (p *Parser) plausibleCount(d *dishes.Dish, it *Item) {
	if d == nil || it.Quantity <= 0 || it.FromCombo != "" {
		return
	}
	u := it.Unit
	if u == "count" && d.PieceGrams > 0 {
		u = "piece"
	}
	max, ok := p.r.PlausibleMax[u]
	// a counted dish served by the plate or katori ("1 plate idli"): how
	// many pieces is that? ask
	bowlOfCounted := d.Unit == "count" && d.PieceGrams == 0 && (u == "plate" || u == "katori" || u == "bowl")
	if !bowlOfCounted && (!ok || it.Quantity <= max) {
		return
	}
	p.unitOptions(d, it)
}

// unitOptions flags unit_mismatch and offers the counting-unit reading,
// the stated reading and one standard portion.
func (p *Parser) unitOptions(d *dishes.Dish, it *Item) {
	u := it.Unit
	if u == "count" && d.PieceGrams > 0 {
		u = "piece"
	}
	it.pen("unit_mismatch")
	it.NeedsConfirmation = true
	it.UnitOptions = nil
	add := func(q float64, unit string) {
		c := p.compute(d, Item{OilLevel: it.OilLevel}, q, unit)
		for _, o := range it.UnitOptions {
			if o.Quantity == q && o.Unit == c.Unit {
				return
			}
		}
		it.UnitOptions = append(it.UnitOptions, UnitOption{Quantity: q, Unit: c.Unit, Kcal: c.Kcal.Best})
	}
	cu := CountingUnit(*d)
	if cu != u {
		add(it.Quantity, cu)
	}
	add(it.Quantity, it.Unit)
	if cu == u || d.Unit != u {
		add(1, d.Unit)
	}
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
		if p.filler[w] || p.style[w] {
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
			// one serving made of both parts: a combo row if the table has one...
			if combo := p.comboFor(res, group); combo != nil {
				first := group[len(group)-1]
				it := Item{DishID: combo.ID, Name: combo.Name, DataSource: combo.Source, SourceNote: combo.SourceNote,
					clause: res.Items[k].clause, explicit: true}
				for g := len(group) - 1; g >= 0; g-- {
					it.Matched = strings.TrimSpace(it.Matched + " " + res.Items[group[g]].Matched)
				}
				it = p.compute(combo, it, qty, unit)
				if combo.OilSensitive {
					it = p.withOil(&it, "normal")
				}
				it.pen("combo_or_split")
				keep := res.Items[:0:0]
				for idx, x := range res.Items {
					in := false
					for _, g := range group {
						in = in || g == idx
					}
					if idx == first {
						keep = append(keep, it)
					} else if !in {
						keep = append(keep, x)
					}
				}
				res.Items = keep
				return
			}
			// ...otherwise split one serving by each part's calorie share
			var sumK, sumG float64
			for _, g := range group {
				d := p.dishByID(res.Items[g].DishID)
				sumK += d.Kcal
				sumG += d.PortionGrams
			}
			for _, g := range group {
				it := &res.Items[g]
				d := p.dishByID(it.DishID)
				share := 1.0 / float64(len(group))
				if sumK > 0 {
					share = d.Kcal / sumK
				}
				*it = p.rescale(it, round(qty*share, 2), unit)
				it.explicit = true
				it.pen("combo_or_split")
			}
			return
		}
	}
	it := &res.Items[k]
	d := p.dishByID(it.DishID)
	if it.FromCombo == "" && len(d.Parts) > 0 && unit != "" && unit != d.Unit {
		parts := p.expand(d, qty, unit, it.OilLevel, it.Matched, it.Fuzzy)
		for i := range parts {
			parts[i].clause = it.clause
		}
		res.Items = append(res.Items[:k], append(parts, res.Items[k+1:]...)...)
		return
	}
	if unit == "" && p.eggBowl(d) && p.hasEggWord(it.Matched) {
		its := p.eggCurry(d, qty, it.OilLevel, it.Matched, it.Fuzzy) // "3 ande ki curry"
		for i := range its {
			its[i].clause = it.clause
		}
		res.Items = append(res.Items[:k], append(its, res.Items[k+1:]...)...)
		return
	}
	if unit == "" && d.PieceGrams > 0 {
		unit = "piece"
	}
	fits := p.fat[d.ID] || p.unitFits(d, unit, true)
	*it = p.rescale(it, qty, unit)
	it.explicit = true
	if !fits {
		it.pen("unit_mismatch") // a count that doesn't fit a bowl dish: ask
	}
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
	for j < len(toks) && !toks[j].sep && p.filler[toks[j].w] && !p.sep[toks[j].w] {
		j++
	}
	return j >= len(toks) || toks[j].sep || p.sep[toks[j].w] // "poha 1 plate aur chai": the plate is poha's
}

// comboFor finds a table row that is exactly these parts ("rajma" + "rice" -> rajma chawal).
func (p *Parser) comboFor(res *Result, group []int) *dishes.Dish {
	want := map[string]bool{}
	for _, g := range group {
		want[res.Items[g].DishID] = true
	}
	for i := range p.table {
		d := &p.table[i]
		if len(d.Parts) != len(want) {
			continue
		}
		ok := true
		for _, pt := range d.Parts {
			ok = ok && want[pt.DishID]
		}
		if ok {
			return d
		}
	}
	return nil
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
	if pd.hasQty && pd.unit == "" && p.eggBowl(d) && p.hasEggWord(matched) {
		return p.eggCurry(d, qty, pd.oil, matched, fuzzy) // "3 ande ki curry": the count is eggs, not bowls
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
	capped := false
	if p.fat[d.ID] {
		oil = ""
		capped = (unit == "" || unit == "spoon") && qty > p.r.MaxFatSpoons
	}
	if len(d.Parts) > 0 && pd.unit != "" && pd.unit != d.Unit {
		return p.expand(d, qty, unit, oil, matched, fuzzy)
	}
	if d.PieceGrams > 0 && pd.hasQty && (unit == "" || unit == "count") {
		unit = "piece" // "8 momos" = 8 pieces
	}
	it := Item{DishID: d.ID, Name: d.Name, Matched: matched, DataSource: d.Source, SourceNote: d.SourceNote, Fuzzy: fuzzy, explicit: pd.hasQty || pd.unit != ""}
	it = p.compute(d, it, qty, unit)
	if !p.fat[d.ID] && !p.unitFits(d, pd.unit, pd.hasQty) {
		it.pen("unit_mismatch") // "2 egg curry", "1 glass roti": ask, never guess
	}
	if capped {
		it.pen("capped")
		it.NeedsConfirmation = true
	}
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

// bowlDish: a dish served by the bowl, where a bare count does not fit.
func (p *Parser) bowlDish(d *dishes.Dish) bool { return !p.unitFits(d, "", true) }

// eggBowl: a bowl dish where whole eggs sit in a gravy (rules egg_piece_bowls).
func (p *Parser) eggBowl(d *dishes.Dish) bool {
	return p.r.EggsPerPortion[d.ID] > 0 && p.bowlDish(d) && slices.Contains(p.r.EggPieceBowls, d.ID)
}

// eggPieces adds the boiled-egg pieces stashed by applyForm.
func (p *Parser) eggPieces(res *Result) {
	var out []Item
	for _, it := range res.Items {
		extra := it.eggExtra
		it.eggExtra = 0
		if extra <= 0 {
			out = append(out, it)
			continue
		}
		e := p.dishByID(p.r.EggPieceDish)
		it.FromCombo, it.everyday = it.DishID, true
		out = append(out, it)
		if e != nil {
			b := p.build(e, pending{qty: extra, hasQty: true}, it.Matched, it.Fuzzy)
			for k := range b {
				b[k].FromCombo, b[k].everyday, b[k].clause, b[k].joined = it.DishID, true, it.clause, it.joined
				b[k].pen("egg_count")
			}
			out = append(out, b...)
		}
	}
	res.Items = out
}

func (p *Parser) hasEggWord(matched string) bool {
	for _, w := range strings.Fields(matched) {
		if p.eggWord[w] {
			return true
		}
	}
	return false
}

// eggCurry: an egg count on a bowl dish ("egg curry 3 eggs"). One bowl holds
// eggs_per_portion eggs; extra eggs are added as boiled-egg pieces. Both parts
// are flagged egg_count so the user confirms.
func (p *Parser) eggCurry(d *dishes.Dish, eggs float64, oil, matched string, fuzzy bool) []Item {
	per := p.r.EggsPerPortion[d.ID]
	q := 1.0
	if eggs < per {
		q = round(eggs/per, 2)
	}
	out := p.build(d, pending{qty: q, hasQty: true, unit: d.Unit, oil: oil}, matched, fuzzy)
	if extra := eggs - per; extra > 0 {
		if e := p.dishByID(p.r.EggPieceDish); e != nil {
			out = append(out, p.build(e, pending{qty: extra, hasQty: true}, matched, fuzzy)...)
		}
	}
	for k := range out {
		out[k].FromCombo, out[k].everyday = d.ID, true // one phrase, two parts: each gets its own span
		out[k].pen("egg_count")
		out[k].explicit = true
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
		if len(it.UnitOptions) > 0 {
			continue // unit_mismatch: out of the totals until confirmed
		}
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

// TableVersion is the dish table version this parser uses.
func (p *Parser) TableVersion() int { return dishes.TableVersion(p.table) }

// TableOnly reports whether the table may answer this meal on its own (the
// strict rule): every span is an exact or alias match with a stated count or
// unit, and nothing was left over, split, combined, fuzzy-matched, flagged
// or estimated. Anything else goes to the AI with this parse as a hint.
func (p *Parser) TableOnly(r Result) bool {
	if len(r.Items) == 0 || len(r.Unmatched) > 0 {
		return false
	}
	for _, it := range r.Items {
		if d := p.dishByID(it.DishID); d == nil || len(d.Parts) > 0 || d.NeedsConfirm {
			return false // combo rows and generic rows never answer alone
		}
		if it.Source != SourceTable || it.NeedsConfirmation || it.Fuzzy || (it.FromCombo != "" && !it.everyday) || it.generic ||
			p.blockingFlags(it.Flags) || it.Unit == "" || (p.r.StrictStatedQty && !it.stated) {
			return false
		}
	}
	return true
}

// blockingFlags: any flag except the informational ones (rules
// table_only_ok_flags, e.g. trailing_qty in "masala dosa 1") keeps the AI on.
func (p *Parser) blockingFlags(fl []string) bool {
	for _, f := range fl {
		if !slices.Contains(p.r.TableOnlyOKFlags, f) {
			return true
		}
	}
	return false
}

type comboPart struct {
	DishID string  `json:"dish_id"`
	Qty    float64 `json:"qty"`
}

// everydayCombos replaces an everyday combo row read without a portion (or
// in its own unit, "2 plate dal chawal") with its component dishes at their
// default portions. Combos given in another unit keep the split rule.
func (p *Parser) everydayCombos(res *Result) {
	var out []Item
	for _, it := range res.Items {
		raw, ok := p.r.EverydayCombos[it.DishID]
		d := p.dishByID(it.DishID)
		if !ok || d == nil || it.Fuzzy || (it.explicit && it.Unit != d.Unit) {
			out = append(out, it)
			continue
		}
		var parts []comboPart
		if json.Unmarshal(raw, &parts) != nil || len(parts) == 0 {
			out = append(out, it)
			continue
		}
		n := it.Quantity
		if n <= 0 {
			n = 1
		}
		for _, pt := range parts {
			cd := p.dishByID(pt.DishID)
			if cd == nil {
				continue
			}
			q := pt.Qty
			if q == 0 {
				q = 1
			}
			c := Item{DishID: cd.ID, Name: cd.Name, Matched: it.Matched, DataSource: cd.Source, SourceNote: cd.SourceNote,
				FromCombo: d.ID, everyday: true, clause: it.clause, joined: it.joined}
			if p.fat[cd.ID] {
				q *= p.r.DefaultFatSpoon
			}
			c = p.compute(cd, c, round(q*n, 2), "")
			if n < 1 || n != math.Floor(n) {
				c.pen("fractional_combo") // "half plate chole bhature": every part scales, the user checks it
			}
			if cd.OilSensitive {
				c = p.withOil(&c, "normal")
			}
			out = append(out, c)
		}
	}
	res.Items = out
}

// unitFits: a typed unit must describe the dish's unit, and a bare count
// ("2 egg curry") only fits countable dishes or ones with a per-piece size.
func (p *Parser) unitFits(d *dishes.Dish, unit string, hasQty bool) bool {
	if unit == "" {
		if !hasQty || d.PieceGrams > 0 {
			return true
		}
		for _, u := range p.r.BareCountUnits {
			if u == d.Unit {
				return true
			}
		}
		return false
	}
	if unit == d.Unit || unit == "g" || unit == "gram" || unit == "ml" {
		return true
	}
	raw, ok := p.r.UnitFits[unit]
	if !ok {
		return true // unit words without a rule are left alone
	}
	var fits []string
	_ = json.Unmarshal(raw, &fits)
	for _, u := range fits {
		if u == d.Unit {
			return true
		}
	}
	return false
}

// tokenRules enforces two invariants over the finished items:
//  1. each input token feeds at most one item (a token claimed twice makes
//     every item using it a did-you-mean);
//  2. dishes typed next to each other with nothing in between stay separate
//     table items only if they form an everyday pair; otherwise the phrase
//     could be one unknown dish, so they need a decision (and go to the AI).
func (p *Parser) tokenRules(res *Result, toks []token) {
	words := make([]string, len(toks))
	for i, t := range toks {
		if !t.sep && !t.isN {
			words[i] = t.w
		}
	}
	used := make([]int, len(toks)) // item index+1 that claimed each token
	type span struct{ a, b int }
	spans := make([]span, len(res.Items))
	group := func(i int) string { // everyday combo parts share their words
		it := res.Items[i]
		if it.FromCombo != "" {
			return it.FromCombo + "|" + it.Matched
		}
		return strconv.Itoa(i)
	}
	claimed := map[string]span{}
	cursor := 0
	for i := range res.Items {
		spans[i] = span{-1, -1}
		g := group(i)
		if sp, ok := claimed[g]; ok {
			spans[i] = sp
			continue
		}
		ws := strings.Fields(res.Items[i].Matched)
		if len(ws) == 0 {
			continue
		}
		find := func(from int, free bool) int {
			for s := from; s+len(ws) <= len(words); s++ {
				ok := true
				for k, w := range ws {
					if words[s+k] != w || (free && used[s+k] != 0) {
						ok = false
						break
					}
				}
				if ok {
					return s
				}
			}
			return -1
		}
		at := find(cursor, true)
		if at < 0 {
			at = find(0, true)
		}
		if at < 0 {
			if prev := find(0, false); prev >= 0 {
				// every occurrence is already used by another item
				other := used[prev] - 1
				res.Items[i].pen("token_reuse")
				res.Items[other].pen("token_reuse")
			}
			continue
		}
		for k := range ws {
			used[at+k] = i + 1
		}
		spans[i] = span{at, at + len(ws) - 1}
		claimed[g] = spans[i]
		cursor = at + len(ws)
	}
	// adjacency
	for i := range res.Items {
		for j := range res.Items {
			if i == j || spans[i].a < 0 || spans[j].a < 0 || group(i) == group(j) {
				continue
			}
			if spans[j].a == spans[i].b+1 && p.qualifierPair(res.Items[i], res.Items[j]) {
				// reads like one dish name: the whole phrase goes to the AI
				res.Items[i].pen("compound_name")
				res.Items[j].pen("compound_name")
			}
			if spans[j].a == spans[i].b+1 && (!p.everydayPair(res.Items[i].DishID, res.Items[j].DishID) || p.qualifierPair(res.Items[i], res.Items[j])) {
				res.Items[i].pen("adjacent_split")
				res.Items[j].pen("adjacent_split")
			}
		}
	}
}

// qualifierPair: "egg rice", "chicken pulao", "paneer roti" - the first
// match is a bare ingredient word naming the next dish, not a side dish.
// Listed dish pairs ("idli sambar") still split.
func (p *Parser) qualifierPair(a, b Item) bool {
	for _, pr := range p.r.EverydayPairs.DishPairs {
		if (pr[0] == a.DishID && pr[1] == b.DishID) || (pr[0] == b.DishID && pr[1] == a.DishID) {
			return false
		}
	}
	w := strings.ToLower(strings.TrimSpace(a.Matched))
	if _, ok := p.r.ProteinWords[w]; ok {
		return true
	}
	return slices.Contains(p.r.NameQualifiers, w)
}

func (p *Parser) everydayPair(a, b string) bool {
	for _, pr := range p.r.EverydayPairs.DishPairs {
		if (pr[0] == a && pr[1] == b) || (pr[0] == b && pr[1] == a) {
			return true
		}
	}
	da, db := p.dishByID(a), p.dishByID(b)
	if da == nil || db == nil {
		return false
	}
	for _, pr := range p.r.EverydayPairs.CategoryPairs {
		if (pr[0] == da.Category && pr[1] == db.Category) || (pr[0] == db.Category && pr[1] == da.Category) {
			return true
		}
	}
	return false
}

// origWord is one word of the user's original text with its normalized
// form(s) and UTF-16 offsets.
type origWord struct {
	norm []string
	s, e int
}

func utf16Len(s string) int { return len(utf16.Encode([]rune(s))) }

// origWords splits the original text into words (letters, digits, marks)
// and normalizes each one the same way the parser does.
func (p *Parser) origWords(text string) []origWord {
	var out []origWord
	pos16, start16, startB := 0, -1, 0
	flush := func(endB, end16 int) {
		if start16 < 0 {
			return
		}
		w := text[startB:endB]
		out = append(out, origWord{norm: strings.Fields(p.normalize(w)), s: start16, e: end16})
		start16 = -1
	}
	for i, r := range text {
		inWord := unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.Is(unicode.Mn, r) || unicode.Is(unicode.Mc, r) || r == '.' && start16 >= 0
		if inWord && start16 < 0 {
			start16, startB = pos16, i
		} else if !inWord {
			flush(i, pos16)
		}
		pos16 += len(utf16.Encode([]rune{r}))
	}
	flush(len(text), pos16)
	return out
}

// locate finds the words of matched (normalized) in order from word index
// `from`, skipping words in `used`; returns word index range [a,b].
func locate(ws []origWord, matched []string, from int, used []bool) (int, int, bool) {
	if len(matched) == 0 {
		return 0, 0, false
	}
	for start := from; start < len(ws); start++ {
		k, a, b := 0, -1, -1
		for i := start; i < len(ws) && k < len(matched); i++ {
			if used != nil && used[i] {
				if a >= 0 {
					break
				}
				continue
			}
			hit := false
			for _, n := range ws[i].norm {
				if k < len(matched) && n == matched[k] {
					k++
					hit = true
				}
			}
			if hit {
				if a < 0 {
					a = i
				}
				b = i
			} else if a >= 0 && i-b > 2 {
				break // allow up to two filler words in between ("aloo ki sabzi")
			}
		}
		if k == len(matched) {
			return a, b, true
		}
	}
	return 0, 0, false
}

// assignSpans sets span_start/span_end on every item. Everyday combo parts
// get one word each when the phrase has one word per part.
func (p *Parser) assignSpans(res *Result, text string) {
	ws := p.origWords(text)
	whole := utf16Len(text)
	used := make([]bool, len(ws))
	cursor := 0
	for i := 0; i < len(res.Items); i++ {
		it := &res.Items[i]
		// everyday combo group
		n := 1
		if it.FromCombo != "" {
			for i+n < len(res.Items) && res.Items[i+n].FromCombo == it.FromCombo && res.Items[i+n].Matched == it.Matched {
				n++
			}
		}
		a, b, ok := locate(ws, strings.Fields(it.Matched), cursor, used)
		if !ok {
			a, b, ok = locate(ws, strings.Fields(it.Matched), 0, used)
		}
		if !ok {
			for k := 0; k < n; k++ {
				res.Items[i+k].SpanStart, res.Items[i+k].SpanEnd = 0, whole
			}
			i += n - 1
			continue
		}
		for x := a; x <= b; x++ {
			used[x] = true
		}
		cursor = b + 1
		if n > 1 && b-a+1 >= n {
			// each combo part gets its own word(s): one each, the last takes the rest
			for k := 0; k < n; k++ {
				x, y := a+k, a+k
				if k == n-1 {
					y = b
				}
				res.Items[i+k].SpanStart, res.Items[i+k].SpanEnd = ws[x].s, ws[y].e
				var m []string
				for z := x; z <= y; z++ {
					m = append(m, ws[z].norm...)
				}
				res.Items[i+k].Matched = strings.Join(m, " ")
			}
		} else {
			for k := 0; k < n; k++ {
				res.Items[i+k].SpanStart, res.Items[i+k].SpanEnd = ws[a].s, ws[b].e
			}
		}
		i += n - 1
	}
}

// Locate returns the UTF-16 span of words (any form the parser would
// normalize to) in text, or the whole text when they can't be found.
func (p *Parser) Locate(text, words string) (int, int, bool) {
	ws := p.origWords(text)
	if a, b, ok := locate(ws, strings.Fields(p.normalize(words)), 0, nil); ok {
		return ws[a].s, ws[b].e, true
	}
	return 0, utf16Len(text), false
}

// Noise reports whether a piece of text has no food words: only numbers,
// units, fillers, connectors, stopwords, oil words or genitives.
func (p *Parser) Noise(text string) bool {
	for _, w := range strings.Fields(p.normalize(text)) {
		if w == "," || w == "." || isNum(w) || p.filler[w] || p.connector[w] || p.stop[w] || p.unitOf[w] != "" ||
			p.oilOf[w] != "" || p.small[w] || p.genitive[w] || p.oilSuf[w] || p.style[w] || len([]rune(w)) < 2 {
			continue
		}
		return false
	}
	return true
}

// Claim reports whether a parsed item can stand as a confident table item
// while the AI handles the rest of the text: it would pass TableOnly on its
// own, apart from being flagged only because the meal had other unknown
// words. The returned copy is marked confident.
func (p *Parser) Claim(it Item) (Item, bool) {
	for _, f := range it.Flags {
		if f != "leftover_in_meal" {
			return it, false
		}
	}
	if it.Fuzzy || it.generic || it.Source == SourceGeneric || it.Source == SourceAI {
		return it, false
	}
	one := it
	one.Flags, one.Source, one.NeedsConfirmation = nil, SourceTable, false
	if !p.TableOnly(Result{Items: []Item{one}}) {
		return it, false
	}
	one.Confidence = 1
	one.pens = nil
	return one, true
}

// adjacency: a table match is confident only if it covers the whole noun
// phrase. Walking outward from the item over noise words (units, fillers,
// stopwords, style/oil words, genitives), the first real word decides:
//   - a separator (aur, and, with, saath, a comma) or a number (the next
//     part's own quantity, or this item's) -> confirmed on that side;
//   - another item's word -> confirmed;
//   - an unclaimed food-like word -> part of the same phrase: the item is
//     unconfirmed (leftover_nearby) and the phrase goes to the AI as one item.
func (p *Parser) adjacency(res *Result, text string) {
	ws := p.origWords(text)
	t16 := utf16.Encode([]rune(text))
	claimedBy := make([]int, len(ws))
	for k := range claimedBy {
		claimedBy[k] = -1
	}
	for i, it := range res.Items {
		for k, w := range ws {
			if w.s >= it.SpanStart && w.e <= it.SpanEnd && it.SpanEnd-it.SpanStart < len(t16) {
				claimedBy[k] = i
			}
		}
	}
	// only words nothing used count as unknown: modifiers the parser consumed
	// ("zyada ghee wale", "normal oil") are not unknown words
	unknown := map[string]bool{}
	for _, u := range res.Unmatched {
		for _, f := range strings.Fields(p.normalize(u)) {
			unknown[f] = true
		}
	}
	gapHasComma := func(a, b int) bool { // between UTF-16 offsets
		if a < 0 || b > len(t16) || a >= b {
			return false
		}
		g := string(utf16.Decode(t16[a:b]))
		return strings.ContainsAny(g, ",;\n")
	}
	side := func(i, from, step int) bool { // true = an unclaimed real word joins this item
		prevEdge := -1
		if step > 0 {
			prevEdge = res.Items[i].SpanEnd
		} else {
			prevEdge = res.Items[i].SpanStart
		}
		for k := from; k >= 0 && k < len(ws); k += step {
			w := ws[k]
			if step > 0 && gapHasComma(prevEdge, w.s) || step < 0 && gapHasComma(w.e, prevEdge) {
				return false
			}
			if step > 0 {
				prevEdge = w.e
			} else {
				prevEdge = w.s
			}
			if claimedBy[k] >= 0 {
				return false
			}
			kind := ""
			for _, n := range w.norm {
				switch {
				case p.sep[n]:
					kind = "sep"
				case isNum(n) || p.r.Numbers[n] > 0:
					if kind == "" {
						kind = "num"
					}
				case p.noiseWord(n) || !unknown[n]:
				default:
					if kind == "" {
						kind = "word"
					}
				}
			}
			switch kind {
			case "sep", "num":
				return false
			case "word":
				return true
			}
		}
		return false
	}
	for i := range res.Items {
		it := &res.Items[i]
		if it.SpanEnd-it.SpanStart >= len(t16) || it.Source != SourceTable && it.Source != SourceDidYouMean {
			continue
		}
		first, last := -1, -1
		for k, w := range ws {
			if claimedBy[k] == i {
				if first < 0 {
					first = k
				}
				last = k
				_ = w
			}
		}
		if first < 0 {
			continue
		}
		if side(i, last+1, 1) || side(i, first-1, -1) {
			it.Flags = appendOnce(it.Flags, "leftover_nearby")
			it.NeedsConfirmation = true
			it.Source = SourceDidYouMean
			if it.Confidence > 0.5 {
				it.Confidence = 0.5
			}
		}
	}
}

func appendOnce(fs []string, f string) []string {
	for _, x := range fs {
		if x == f {
			return fs
		}
	}
	return append(fs, f)
}

// noiseWord: words that never make a dish phrase on their own.
func (p *Parser) noiseWord(w string) bool {
	return p.filler[w] || p.connector[w] || p.stop[w] || p.unitOf[w] != "" || p.oilOf[w] != "" || p.small[w] ||
		p.genitive[w] || p.oilSuf[w] || p.style[w] || len([]rune(w)) < 3
}
