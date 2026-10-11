package dishes

import "testing"

func TestTable(t *testing.T) {
	ds := MustLoad()
	if len(ds) < 150 {
		t.Fatalf("want >=150 dishes, got %d", len(ds))
	}
	units := map[string]bool{"count": true, "katori": true, "spoon": true, "plate": true, "glass": true}
	seen := map[string]string{}
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
		for _, a := range append([]string{d.Name}, d.Aliases...) {
			if o, ok := seen[a]; ok {
				t.Errorf("term %q in %s and %s", a, o, d.ID)
			}
			seen[a] = d.ID
		}
	}
}
