package dishes

import "testing"

func TestTable(t *testing.T) {
	ds := MustLoad()
	if len(ds) < 150 {
		t.Fatalf("want >=150 dishes, got %d", len(ds))
	}
	units := map[string]bool{"count": true, "katori": true, "spoon": true, "plate": true, "glass": true}
	seen := map[string]string{}
	ids := map[string]bool{}
	for _, d := range ds {
		ids[d.ID] = true
	}
	for _, d := range ds {
		if !units[d.Unit] {
			t.Errorf("%s: bad unit %q", d.ID, d.Unit)
		}
		if d.Diet != "veg" && d.Diet != "egg" && d.Diet != "nonveg" || d.Category == "" {
			t.Errorf("%s: bad diet/category", d.ID)
		}
		if d.SourceNote == "" || d.Source == "" {
			t.Errorf("%s: missing source", d.ID)
		}
		if !(d.KcalLow <= d.Kcal && d.Kcal <= d.KcalHigh) || !(d.ProteinLow <= d.ProteinG && d.ProteinG <= d.ProteinHigh) {
			t.Errorf("%s: bad range", d.ID)
		}
		if d.CarbsG < 0 || d.FatG < 0 || d.MacroNote == "" {
			t.Errorf("%s: bad macros", d.ID)
		}
		if d.Source != "estimate" && !d.NeedsVerify {
			t.Errorf("%s: non-estimate rows must be flagged for verification", d.ID)
		}
		for _, p := range d.Parts {
			if !ids[p.DishID] {
				t.Errorf("%s: unknown part %s", d.ID, p.DishID)
			}
		}
		for _, a := range append([]string{d.Name}, d.Aliases...) {
			if o, ok := seen[a]; ok {
				t.Errorf("term %q in %s and %s", a, o, d.ID)
			}
			seen[a] = d.ID
		}
	}
}

func TestTableValidates(t *testing.T) {
	if err := Validate(MustLoad()); err != nil {
		t.Fatal(err)
	}
}
