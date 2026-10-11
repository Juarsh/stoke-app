package parser

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/akarsh/calorie-tracker/internal/dishes"
)

func newP(t testing.TB) *Parser {
	p, err := New(dishes.MustLoad())
	if err != nil {
		t.Fatal(err)
	}
	return p
}

type devMeal struct {
	In        string          `json:"in"`
	Want      [][]interface{} `json:"want"`
	Unmatched []string        `json:"unmatched"`
}

// TestDevMeals runs Coder's dev samples (not the accuracy set).
func TestDevMeals(t *testing.T) {
	var f struct{ Meals []devMeal }
	b, _ := os.ReadFile("testdata/dev-meals.json")
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	p := newP(t)
	for _, m := range f.Meals {
		r := p.Parse(m.In)
		ok := len(r.Items) == len(m.Want)
		for i := 0; ok && i < len(m.Want); i++ {
			ok = r.Items[i].DishID == m.Want[i][0].(string) && r.Items[i].Quantity == m.Want[i][1].(float64)
		}
		if !ok {
			got := [][]interface{}{}
			for _, it := range r.Items {
				got = append(got, []interface{}{it.DishID, it.Quantity, it.Unit})
			}
			t.Errorf("%q: got %v unmatched %v, want %v", m.In, got, r.Unmatched, m.Want)
		}
	}
}

func TestOilAndUnmatched(t *testing.T) {
	p := newP(t)
	n := p.Parse("dal")
	l := p.Parse("dal kam oil")
	x := p.Parse("zyada ghee wali dal")
	if l.Items[0].OilLevel != "less" || l.Items[0].Kcal.Best >= n.Items[0].Kcal.Best {
		t.Errorf("less oil: %+v", l.Items[0])
	}
	if n.Items[0].OilLevel != "normal" {
		t.Errorf("default oil: %+v", n.Items[0])
	}
	_ = x
	r := p.Parse("2 roti and quinoa bowl xyz")
	if len(r.Unmatched) == 0 {
		t.Errorf("want unmatched, got %+v", r)
	}
	e := p.Parse("2 roti zyada oil")
	_ = e
}

func TestRangesOrdered(t *testing.T) {
	p := newP(t)
	for _, s := range []string{"2 roti dal sabzi thoda ghee", "1 plate chole bhature extra oil", "kam tel ki bhindi"} {
		for _, it := range p.Parse(s).Items {
			if !(it.Kcal.Low <= it.Kcal.Best && it.Kcal.Best <= it.Kcal.High) {
				t.Errorf("%s: %+v", s, it)
			}
		}
	}
}

func BenchmarkParse(b *testing.B) {
	p := newP(b)
	for i := 0; i < b.N; i++ {
		p.Parse("2 roti dal sabzi thoda ghee aur 1 katori rajma chawal")
	}
}

func TestOilRules(t *testing.T) {
	p := newP(t)
	if it := p.Parse("dal kam tel").Items[0]; it.OilLevel != "less" {
		t.Errorf("kam tel: %+v", it)
	}
	if it := p.Parse("sabzi ghee wali").Items[0]; it.OilLevel != "extra" {
		t.Errorf("ghee wali: %+v", it)
	}
	r := p.Parse("aloo paratha zyada ghee")
	if len(r.Items) != 2 || r.Items[1].Quantity != 2 {
		t.Errorf("zyada ghee: %+v", r.Items)
	}
}

func TestNoFallbackForFillers(t *testing.T) {
	p := newP(t)
	for _, s := range []string{"bas thoda sa rice", "grilled paneer", "2 glass paani", "momos chicken wale"} {
		if r := p.Parse(s); len(r.Unmatched) != 0 || len(r.Items) == 0 {
			t.Errorf("%q: %+v", s, r)
		}
	}
}

func TestProteinOverride(t *testing.T) {
	p := newP(t)
	r := p.Parse("chicken steamed momos")
	if len(r.Items) != 1 || r.Items[0].DishID != "chicken_momos" {
		t.Errorf("%+v", r.Items)
	}
}

func TestMacros(t *testing.T) {
	p := newP(t)
	it := p.Parse("2 roti").Items[0]
	if it.CarbsG <= 0 || it.FatG <= 0 {
		t.Errorf("macros: %+v", it)
	}
}

func TestSanityCheck(t *testing.T) {
	p := newP(t)
	it := p.Parse("6 plate momos").Items[0]
	if !it.NeedsConfirmation || len(it.Alternatives) < 2 || it.Alternatives[0].Unit != "piece" {
		t.Errorf("6 plates: %+v", it)
	}
	if it := p.Parse("6 momos").Items[0]; it.NeedsConfirmation {
		t.Errorf("6 pieces flagged: %+v", it)
	}
	if it := p.Parse("2 roti").Items[0]; it.NeedsConfirmation {
		t.Errorf("normal flagged")
	}
	if it := p.Parse("5 plate chicken biryani").Items[0]; !it.NeedsConfirmation {
		t.Errorf("over 1000 kcal not flagged: %+v", it)
	}
}

// Protein / ingredient words must never be ignored: they modify a dish or become an item.
func TestIgnoreListSafe(t *testing.T) {
	p := newP(t)
	for w := range p.r.ProteinWords {
		if p.filler[w] || p.oilSuf[w] || p.genitive[w] {
			t.Errorf("protein word %q is on the ignore list", w)
		}
	}
	for _, d := range p.Table() {
		for _, term := range append([]string{d.Name}, d.Aliases...) {
			if p.filler[term] {
				t.Errorf("dish term %q (%s) is on the ignore list", term, d.ID)
			}
		}
	}
	for _, w := range []string{"chicken", "paneer", "egg", "fish", "mutton", "soya chunks", "anda", "tofu"} {
		r := p.Parse(w)
		if len(r.Items) == 0 && len(r.Unmatched) == 0 {
			t.Errorf("%q dropped", w)
		}
		if len(r.Items) != 1 {
			t.Errorf("%q: want an item, got %+v", w, r)
		}
	}
	// as modifiers
	for in, want := range map[string]string{"chicken momos": "chicken_momos", "egg biryani": "egg_biryani", "paneer paratha": "paneer_paratha", "steamed chicken momos": "chicken_momos"} {
		if r := p.Parse(in); len(r.Items) != 1 || r.Items[0].DishID != want {
			t.Errorf("%q: %+v", in, r.Items)
		}
	}
	// unknown dish with a protein word: the word reaches the fallback, never silently dropped
	r := p.Parse("fish xyzzy")
	if len(r.Items) == 0 && !strings.Contains(strings.Join(r.Unmatched, " "), "fish") {
		t.Errorf("fish dropped: %+v", r)
	}
}

func TestSourcesAndConfirmation(t *testing.T) {
	p := newP(t)
	cases := map[string]struct {
		src     string
		confirm bool
	}{
		"2 roti":          {SourceTable, false},
		"2 chapatii":      {SourceDidYouMean, true},
		"paneer lababdar": {SourceGeneric, true},
		"6 plate momos":   {SourceTable, true},
		"soya chaap":      {SourceTable, false},
	}
	for in, want := range cases {
		it := p.Parse(in).Items[0]
		if it.Source != want.src || it.NeedsConfirmation != want.confirm {
			t.Errorf("%q: source %s confirm %v, want %+v", in, it.Source, it.NeedsConfirmation, want)
		}
	}
	// generic items never 0 kcal and carry a wide range
	it := p.Parse("mutton something new").Items[0]
	if it.Kcal.Best <= 0 || it.Kcal.High < 1.4*it.Kcal.Best {
		t.Errorf("generic range: %+v", it)
	}
	// chaap is never corrected to chaas
	for _, s := range []string{"chaap", "soya chaap", "soy chaap"} {
		if it := p.Parse(s).Items[0]; it.DishID != "soya_chaap" {
			t.Errorf("%q -> %s", s, it.DishID)
		}
	}
}

func TestFormAfterDish(t *testing.T) {
	p := newP(t)
	for in, want := range map[string]string{
		"soya chaap roll":       "soya_chaap_roll",
		"2 soya chaap roll":     "soya_chaap_roll",
		"paneer tikka roll":     "paneer_roll",
		"tandoori chicken wrap": "chicken_roll",
		"rajma wrap":            "generic_wrap",
		"chicken tikka masala":  "chicken_tikka",
	} {
		r := p.Parse(in)
		if len(r.Items) != 1 || r.Items[0].DishID != want || len(r.Unmatched) != 0 {
			t.Errorf("%q: got %+v unmatched %v, want %s", in, r.Items, r.Unmatched, want)
		}
	}
	if it := p.Parse("rajma wrap").Items[0]; !it.NeedsConfirmation || it.Source != SourceGeneric {
		t.Errorf("generic wrap must need confirmation: %+v", it)
	}
}
