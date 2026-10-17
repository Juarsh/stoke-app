package app

import (
	"testing"
)

// Tester rg6 F1 / F5: a table row is never stored differently from what the
// phone sent without saying so.
//   - qty 0 (or below) on a confirmed table row: 400 with a readable reason, never stored as 1;
//   - a unit the dish can't be saved in (parser.UnitSupported: dal as piece,
//     veg biryani as spoon, any dish as litre): stored needs_review, so it is
//     never counted (the app shows the server's version in Review);
//   - a supported unit saves confirmed at the phone's numbers.
func TestTableQtyAndUnitRules(t *testing.T) {
	srv, _ := setup(t, nil)
	u := "unitq"
	day := "2026-10-17"
	type errBody struct {
		Error string
	}
	post := func(item M) (int, M, errBody) {
		var out struct {
			Entries []M
		}
		var eb errBody
		c := call(t, srv, "POST", "/v1/entries", u, M{"local_date": day, "items": []M{item}}, &out)
		if c != 201 {
			call(t, srv, "POST", "/v1/entries", u, M{"local_date": day, "items": []M{item}}, &eb)
			return c, nil, eb
		}
		return c, out.Entries[0], eb
	}
	for _, q := range []float64{0, -1} {
		c, _, eb := post(M{"dish_id": "roti", "qty": q, "unit": "count", "source": "table", "confirmed": true})
		if c != 400 || eb.Error != "item 0: Enter an amount above 0." {
			t.Errorf("qty %v: %d %q", q, c, eb.Error)
		}
	}
	if c, e, _ := post(M{"dish_id": "roti", "source": "table"}); c != 201 || e["qty"] != float64(1) {
		t.Errorf("qty omitted keeps the default 1: %d %v", c, e)
	}
	if c, _, _ := post(M{"dish_id": "roti", "qty": 1, "source": "table", "bogus": 1}); c != 400 {
		t.Errorf("unknown item field still refused: %d", c)
	}
	for _, tc := range []struct{ dish, unit string }{{"dal", "piece"}, {"veg_biryani", "spoon"}, {"dal", "litre"}, {"ghee", "katori"}} {
		c, e, eb := post(M{"dish_id": tc.dish, "qty": 1, "unit": tc.unit, "source": "table", "confirmed": true, "kcal": 150, "dish_table_version": 1, "variant_dish_id": tc.dish})
		if c != 201 || e["state"] != "needs_review" {
			t.Errorf("%s as %s: %d %v %v (want needs_review, never counted)", tc.dish, tc.unit, c, e, eb)
		}
	}
	if c, e, _ := post(M{"dish_id": "dal", "qty": 2, "unit": "katori", "source": "table", "confirmed": true}); c != 201 || e["state"] != "confirmed" || e["unit"] != "katori" || e["qty"] != float64(2) {
		t.Errorf("dal 2 katori: %d %v", c, e)
	}
	var list struct {
		Entries []M
		Total   struct{ Kcal float64 }
	}
	call(t, srv, "GET", "/v1/entries?date="+day, u, nil, &list)
	var sum struct {
		KcalIn float64 `json:"kcal_in"`
	}
	call(t, srv, "GET", "/v1/summary?date="+day, u, nil, &sum)
	var counted float64
	for _, e := range list.Entries {
		if e["state"] != "needs_review" {
			counted += e["kcal_best"].(float64)
		}
	}
	if sum.KcalIn != list.Total.Kcal || counted != list.Total.Kcal {
		t.Errorf("summary %v total %v rows %v", sum.KcalIn, list.Total.Kcal, counted)
	}
}

// PATCH qty 0 on a table row: 400 with the reason, the row is unchanged.
func TestPatchQtyZeroRefused(t *testing.T) {
	srv, _ := setup(t, nil)
	u := "unitq2"
	var out struct{ Entries []M }
	if c := call(t, srv, "POST", "/v1/entries", u, M{"local_date": "2026-10-17", "items": []M{{"dish_id": "roti", "qty": 2, "source": "table", "client_id": "r2"}}}, &out); c != 201 {
		t.Fatalf("post: %d", c)
	}
	var eb struct{ Error string }
	if c := call(t, srv, "PATCH", "/v1/entries/r2", u, M{"qty": 0}, &eb); c != 400 || eb.Error != "Enter an amount above 0." {
		t.Errorf("PATCH qty 0: %d %q", c, eb.Error)
	}
	var list struct {
		Entries []M
	}
	call(t, srv, "GET", "/v1/entries?date=2026-10-17", u, nil, &list)
	if len(list.Entries) != 1 || list.Entries[0]["qty"] != float64(2) {
		t.Errorf("row changed: %v", list.Entries)
	}
}
