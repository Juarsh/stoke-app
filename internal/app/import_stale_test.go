package app

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strconv"
	"testing"
)

// rg7 import path: a dish imported after the phone's table version is saved
// against the current table (no "unknown dish_id" from a stale version), and
// every food response carries X-Dish-Table-Version so the phone knows to pull.
func TestImportedDishFromStalePhone(t *testing.T) {
	srv, _ := setupCfg(t, nil, func(c *Config) { c.AdminToken = testAdmin })
	ver := func(res *http.Response) int { v, _ := strconv.Atoi(res.Header.Get("X-Dish-Table-Version")); return v }
	do := func(method, path string, body any, out any) (*http.Response, int) {
		b, _ := json.Marshal(body)
		req, _ := http.NewRequest(method, srv.URL+path, bytes.NewReader(b))
		req.Header.Set("Authorization", "Bearer good-stale")
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if out != nil {
			_ = json.NewDecoder(res.Body).Decode(out)
		}
		return res, res.StatusCode
	}
	r0, _ := do("GET", "/v1/entries?date=2026-10-17", nil, nil)
	old := ver(r0)
	if old == 0 {
		t.Fatal("no X-Dish-Table-Version on GET /v1/entries")
	}
	row := M{"id": "zarda_pulao", "name": "zarda pulao", "aliases": []string{"zarda", "meetha chawal"}, "unit": "plate", "portion_grams": 200,
		"kcal": 390, "kcal_low": 320, "kcal_high": 470, "protein_g": 5, "protein_low": 4, "protein_high": 6.5, "carbs_g": 72, "fat_g": 9,
		"diet": "veg", "category": "main", "source": "ifct2017", "source_note": "IFCT 2017 rice + sugar + ghee recipe calc"}
	var why M
	if c := admin(t, srv, "POST", "/admin/dishes/import", testAdmin, M{"items": []M{row}, "note": "stale phone test"}, &why); c != 201 {
		t.Fatalf("import: %d %v", c, why)
	}
	nv := int(why["dish_table_version"].(float64))
	var cr struct {
		Entries []struct {
			entry
			State    string `json:"state"`
			TableVer *int   `json:"dish_table_version"`
		}
	}
	item := func(dish, unit string, v int) M {
		return M{"local_date": "2026-10-17", "items": []M{{"dish_id": dish, "qty": 1, "unit": unit, "source": "table", "confirmed": true, "dish_table_version": v}}}
	}
	res, c := do("POST", "/v1/entries", item("zarda_pulao", "plate", old), &cr)
	if c != 201 || len(cr.Entries) != 1 || cr.Entries[0].State != "confirmed" || cr.Entries[0].KcalBest != 390 {
		t.Fatalf("new dish from a version-%d phone: %d %+v", old, c, cr)
	}
	if cr.Entries[0].TableVer == nil || *cr.Entries[0].TableVer != nv {
		t.Errorf("stored table version %v, want %d (the table that has the dish)", cr.Entries[0].TableVer, nv)
	}
	if ver(res) != nv {
		t.Errorf("POST header version %d, want %d", ver(res), nv)
	}
	// a dish in no table is still refused
	var e M
	if _, c := do("POST", "/v1/entries", item("no_such_dish", "plate", old), &e); c != 400 {
		t.Errorf("unknown dish: %d %v", c, e)
	}
}
