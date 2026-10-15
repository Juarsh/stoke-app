package app

import "testing"

// A kcal that doesn't match its dish and unit is saved "corrected" with the
// server's numbers, never at the client's kcal and never rejected.
func TestSaveCorrectedNumbers(t *testing.T) {
	srv, _ := setup(t, nil)
	type e struct {
		KcalBest float64 `json:"kcal_best"`
		State    string  `json:"state"`
		Unit     string  `json:"unit"`
	}
	var out struct{ Entries []e }
	// 8 momos sent with a plate-sized kcal (8 plates = 2400) but unit piece
	c := call(t, srv, "POST", "/v1/entries", "sc", M{"items": []M{{"dish_id": "momos", "qty": 8, "unit": "piece", "source": "table",
		"dish_table_version": 2, "kcal": 2400, "protein_g": 12, "client_id": "m1"}}}, &out)
	if c != 201 || out.Entries[0].State != "corrected" || out.Entries[0].KcalBest > 600 || out.Entries[0].Unit != "piece" {
		t.Fatalf("plate kcal with unit piece: %d %+v", c, out)
	}
	// AI estimate: kcal must be kcal_per_unit x qty
	out.Entries = nil
	c = call(t, srv, "POST", "/v1/entries", "sc", M{"items": []M{{"custom_name": "thukpa", "qty": 2, "unit": "plate", "source": "ai_estimate",
		"confirmed": true, "kcal_per_unit": 290, "kcal": 290, "protein_g": 10, "client_id": "a1"}}}, &out)
	if c != 201 || out.Entries[0].State != "corrected" || out.Entries[0].KcalBest != 580 {
		t.Fatalf("ai kcal_per_unit: %d %+v", c, out)
	}
	out.Entries = nil
	c = call(t, srv, "POST", "/v1/entries", "sc", M{"items": []M{{"custom_name": "thukpa", "qty": 2, "unit": "plate", "source": "ai_estimate",
		"confirmed": true, "kcal_per_unit": 290, "kcal": 580, "protein_g": 10, "client_id": "a2"}}}, &out)
	if c != 201 || out.Entries[0].State != "confirmed" {
		t.Fatalf("matching ai numbers: %d %+v", c, out)
	}
	for _, bad := range []float64{0, -5, 9000} {
		if c := call(t, srv, "POST", "/v1/entries", "sc", M{"items": []M{{"custom_name": "x", "qty": 1, "source": "ai_estimate",
			"confirmed": true, "kcal_per_unit": bad, "kcal": 100}}}, nil); c != 400 {
			t.Errorf("kcal_per_unit %v: %d", bad, c)
		}
	}
	// corrected entries count in the day's totals
	var day struct {
		Total struct{ Kcal float64 }
	}
	call(t, srv, "GET", "/v1/entries", "sc", nil, &day)
	if day.Total.Kcal < 580+580 {
		t.Errorf("totals skip corrected: %+v", day)
	}
	// a plate/katori dish sent with unit piece and the client's kcal: never
	// confirmed; needs_review, recomputed by the server
	for i, d := range []string{"poha", "dal"} {
		out.Entries = nil
		c := call(t, srv, "POST", "/v1/entries", "sc", M{"items": []M{{"dish_id": d, "qty": 1, "unit": "piece", "source": "table", "confirmed": true,
			"dish_table_version": 2, "kcal": 999, "protein_g": 1, "client_id": "p" + string(rune('0'+i))}}}, &out)
		if c != 201 || out.Entries[0].State != "needs_review" || out.Entries[0].KcalBest == 999 {
			t.Errorf("%s as piece: %d %+v", d, c, out)
		}
	}
	// kcal_per_unit on a table item: 400
	if c := call(t, srv, "POST", "/v1/entries", "sc", M{"items": []M{{"dish_id": "roti", "qty": 2, "unit": "count", "source": "table",
		"dish_table_version": 2, "kcal_per_unit": 110, "client_id": "kpu"}}}, nil); c != 400 {
		t.Errorf("table kcal_per_unit: %d", c)
	}
	var v struct {
		Commit  string `json:"commit"`
		BuiltAt string `json:"built_at"`
	}
	if c := call(t, srv, "GET", "/version", "", nil, &v); c != 200 || v.Commit == "" || v.BuiltAt == "" {
		t.Errorf("/version: %d %+v", c, v)
	}
}
