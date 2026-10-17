package parser

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/akarsh/calorie-tracker/internal/dishes"
)

// testdata/supported_units.json is the unit chips each table dish can be
// saved in (SupportedUnits). The app keeps a byte-identical copy
// (src/data/supported-units.json) and checks its own rule against it, so the
// edit sheet never offers a unit the server would not save as confirmed.
// Regenerate with UPDATE_GOLDEN=1 go test ./internal/parser -run SupportedUnits.
func TestSupportedUnitsGolden(t *testing.T) {
	p, err := New(dishes.MustLoad())
	if err != nil {
		t.Fatal(err)
	}
	got := map[string][]string{}
	for _, d := range p.Table() {
		got[d.ID] = p.SupportedUnits(d.ID)
		if len(got[d.ID]) == 0 {
			t.Errorf("%s: no supported unit", d.ID)
		}
		if Units[d.Unit] && !p.UnitSupported(d.ID, d.Unit) && !p.fat[d.ID] {
			t.Errorf("%s: its own unit %s is not supported", d.ID, d.Unit)
		}
		for _, u := range got[d.ID] {
			it, err := p.Recompute(d.ID, 2, u, "")
			if err != nil || it.Unit != u || it.Quantity != 2 {
				t.Errorf("%s in %s: recompute changes it: %v %s %v", d.ID, u, err, it.Unit, it.Quantity)
			}
		}
	}
	b, _ := json.MarshalIndent(got, "", "  ")
	b = append(b, '\n')
	const f = "testdata/supported_units.json"
	if os.Getenv("UPDATE_GOLDEN") == "1" {
		if err := os.WriteFile(f, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(f)
	if err != nil {
		t.Fatalf("%v (UPDATE_GOLDEN=1 to create)", err)
	}
	if string(want) != string(b) {
		t.Errorf("%s is stale: UPDATE_GOLDEN=1 go test ./internal/parser -run SupportedUnits, then copy it to the app's src/data/supported-units.json", f)
	}
}
