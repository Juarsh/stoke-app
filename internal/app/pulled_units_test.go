package app

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"strconv"
	"testing"

	"github.com/akarsh/calorie-tracker/internal/food"
)

// PE (rg6 follow-up): per-dish supported units come down WITH the dish table,
// under the same table version: GET /v1/dishes and cmd/dishes-pull carry
// supported_units per dish. Import one new dish, pull, then save it in each
// of the 7 units: the server confirms exactly the pulled units (what the
// phone offers) and keeps every other unit for review (not counted).
func TestPulledUnitsNewDish(t *testing.T) {
	srv, pool := setupCfg(t, nil, func(c *Config) { c.AdminToken = testAdmin })
	row := M{"id": "kodo_khichdi", "name": "kodo khichdi", "aliases": []string{"kodo millet khichdi"}, "unit": "katori", "portion_grams": 180,
		"kcal": 210, "kcal_low": 170, "kcal_high": 260, "protein_g": 6, "protein_low": 4.5, "protein_high": 7.5, "carbs_g": 34, "fat_g": 5,
		"diet": "veg", "category": "main", "source": "usda_fdc", "source_note": "Checked against IFCT 2017 kodo millet + moong dal recipe calc"}
	var imp struct {
		Version int `json:"dish_table_version"`
	}
	var why M
	if c := admin(t, srv, "POST", "/admin/dishes/import", testAdmin, M{"items": []M{row}, "note": "units pull test"}, &why); c != 201 {
		t.Fatalf("import: %d %v", c, why)
	}
	imp.Version = int(why["dish_table_version"].(float64))
	// GET /v1/dishes: every dish has supported_units, under the new version
	res, err := http.Get(srv.URL + "/v1/dishes")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if v, _ := strconv.Atoi(res.Header.Get("X-Dish-Table-Version")); v != imp.Version {
		t.Errorf("served version %d, imported %d", v, imp.Version)
	}
	var served []struct {
		ID    string   `json:"id"`
		Units []string `json:"supported_units"`
	}
	if err := json.NewDecoder(res.Body).Decode(&served); err != nil {
		t.Fatal(err)
	}
	units := map[string][]string{}
	for _, d := range served {
		if len(d.Units) == 0 {
			t.Errorf("%s: no supported_units served", d.ID)
		}
		units[d.ID] = d.Units
	}
	if len(units["kodo_khichdi"]) == 0 || !slices.Contains(units["kodo_khichdi"], "katori") {
		t.Fatalf("new dish units: %v", units["kodo_khichdi"])
	}
	// cmd/dishes-pull: the same table version and the same units
	v, raw, err := food.PullTable(context.Background(), pool)
	if err != nil || v != imp.Version {
		t.Fatalf("pull: v=%d err=%v", v, err)
	}
	var pulled []struct {
		ID    string   `json:"id"`
		Units []string `json:"supported_units"`
	}
	if err := json.Unmarshal(raw, &pulled); err != nil || len(pulled) != len(served) {
		t.Fatalf("pulled: %v %d/%d", err, len(pulled), len(served))
	}
	for _, d := range pulled {
		if !slices.Equal(d.Units, units[d.ID]) {
			t.Errorf("%s: pulled %v, served %v", d.ID, d.Units, units[d.ID])
		}
	}
	// save the new dish in each unit: confirmed exactly for the pulled units
	total := 0.0
	for _, u := range []string{"count", "piece", "katori", "spoon", "plate", "glass", "gram"} {
		var cr struct {
			Entries []struct {
				entry
				State string `json:"state"`
			}
		}
		if c := call(t, srv, "POST", "/v1/entries", "pu1", M{"local_date": "2026-10-17", "items": []M{{"dish_id": "kodo_khichdi", "qty": 1, "unit": u,
			"source": "table", "dish_table_version": imp.Version}}}, &cr); c != 201 || len(cr.Entries) != 1 {
			t.Fatalf("%s: %d", u, c)
		}
		e := cr.Entries[0]
		want := "needs_review"
		if slices.Contains(units["kodo_khichdi"], u) {
			want = "confirmed"
			total += e.KcalBest
			if e.Unit != u {
				t.Errorf("%s: saved as %s", u, e.Unit)
			}
		}
		if e.State != want {
			t.Errorf("%s: state %s, want %s (pulled units %v)", u, e.State, want, units["kodo_khichdi"])
		}
	}
	var sum struct {
		KcalIn float64 `json:"kcal_in"`
	}
	call(t, srv, "GET", "/v1/summary?date=2026-10-17", "pu1", nil, &sum)
	if sum.KcalIn != total {
		t.Errorf("summary %v, counted pulled-unit saves %v", sum.KcalIn, total)
	}
}
