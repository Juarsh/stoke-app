package food

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/akarsh/calorie-tracker/internal/dishes"
	"github.com/akarsh/calorie-tracker/internal/parser"
)

// The committed dishes.json (what dishes-pull writes and the app ships) has
// supported_units equal to the save rule for every dish, and AddUnits only
// adds that key (the rows' own bytes stay; the table version is unchanged).
func TestDishesJSONSupportedUnits(t *testing.T) {
	p, err := parser.New(dishes.MustLoad())
	if err != nil {
		t.Fatal(err)
	}
	var rows []struct {
		ID    string   `json:"id"`
		Units []string `json:"supported_units"`
	}
	if err := json.Unmarshal(dishes.Raw(), &rows); err != nil {
		t.Fatal(err)
	}
	for _, r := range rows {
		want := p.SupportedUnits(r.ID)
		if len(r.Units) == 0 || !equal(r.Units, want) {
			t.Errorf("%s: dishes.json supported_units %v, rule %v (run go run ./cmd/dishes-pull -repo)", r.ID, r.Units, want)
		}
	}
	again, err := AddUnits(dishes.Raw(), p.SupportedUnits)
	if err != nil || !bytes.Equal(again, dishes.Raw()) {
		t.Errorf("dishes-pull -repo would change dishes.json (err %v)", err)
	}
	// a compact snapshot (as stored per version) gets the same units
	snap, _ := json.Marshal(dishes.MustLoad())
	out, err := AddUnits(snap, p.SupportedUnits)
	if err != nil {
		t.Fatal(err)
	}
	var back []map[string]any
	if err := json.Unmarshal(out, &back); err != nil || len(back) != len(rows) {
		t.Fatalf("snapshot with units: %v %d", err, len(back))
	}
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
