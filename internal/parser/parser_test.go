package parser

import (
	"encoding/json"
	"os"
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
