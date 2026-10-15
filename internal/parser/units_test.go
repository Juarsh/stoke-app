package parser

import "testing"

// A bare number means the dish's counting unit; a count that doesn't fit
// the stated unit is unit_mismatch with both readings, out of the totals.
func TestCountingUnits(t *testing.T) {
	p := newP(t)
	for _, c := range []struct {
		text, unit string
		qty        float64
	}{{"8 momos", "piece", 8}, {"4 idli", "count", 4}, {"2 samosa", "count", 2}, {"3 roti", "count", 3}} {
		r := p.Parse(c.text)
		if len(r.Items) != 1 {
			t.Fatalf("%q: %+v", c.text, r)
		}
		it := r.Items[0]
		if it.Unit != c.unit || it.Quantity != c.qty || it.NeedsConfirmation || len(it.UnitOptions) != 0 || it.Source != SourceTable {
			t.Errorf("%q: %+v", c.text, it)
		}
		if k, _ := Totals(r.Items); k.Best != it.Kcal.Best {
			t.Errorf("%q total %v", c.text, k.Best)
		}
	}
	if it := p.Parse("8 momos").Items[0]; it.Kcal.Best > 600 {
		t.Errorf("8 momos read as plates: %v kcal", it.Kcal.Best)
	}
	for _, c := range []struct {
		text  string
		units []string
	}{{"8 plates momos", []string{"piece", "plate"}}, {"6 katori dal", []string{"katori"}}} {
		r := p.Parse(c.text)
		it := r.Items[0]
		if !hasF(it.Flags, "unit_mismatch") || !it.NeedsConfirmation || it.Source == SourceTable || len(it.UnitOptions) < 2 {
			t.Fatalf("%q: %+v", c.text, it)
		}
		for _, u := range c.units {
			found := false
			for _, o := range it.UnitOptions {
				found = found || (o.Unit == u && o.Quantity == it.Quantity && o.Kcal > 0)
			}
			if !found {
				t.Errorf("%q: no %v %s option: %+v", c.text, it.Quantity, u, it.UnitOptions)
			}
		}
		if k, _ := Totals(r.Items); k.Best != 0 {
			t.Errorf("%q counted in totals before confirming: %v", c.text, k.Best)
		}
	}
}

func hasF(fs []string, f string) bool {
	for _, x := range fs {
		if x == f {
			return true
		}
	}
	return false
}
