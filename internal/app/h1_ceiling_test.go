package app

import (
	"context"
	"fmt"
	"testing"
)

// H1 (rg7, CEO): a table row is capped at 10,000 kcal and 500 g protein per
// entry (readable 400); the row and the day's summary are written in ONE
// transaction, so a summary that can't be written saves nothing; no input is
// a 500, and a day can never be left with list != summary.

type dayView struct {
	Entries []struct {
		ClientID string  `json:"client_id"`
		KcalBest float64 `json:"kcal_best"`
		State    string  `json:"state"`
	}
	Total struct{ Kcal float64 } `json:"total"`
}

func dayOf(t *testing.T, user string, get func(path string, out any) int) (float64, float64, int) {
	t.Helper()
	var l dayView
	var sum struct {
		KcalIn float64 `json:"kcal_in"`
	}
	if c := get("/v1/entries?date=2026-10-17", &l); c != 200 {
		t.Fatalf("list: %d", c)
	}
	if c := get("/v1/summary?date=2026-10-17", &sum); c != 200 {
		t.Fatalf("summary: %d", c)
	}
	return l.Total.Kcal, sum.KcalIn, len(l.Entries)
}

func TestTableRowCeilingAndNoPoisonedDay(t *testing.T) {
	srv, pool := setup(t, nil)
	const u = "h1"
	get := func(path string, out any) int { return call(t, srv, "GET", path, u, nil, out) }
	post := func(dish string, qty float64, unit string, out any) int {
		return call(t, srv, "POST", "/v1/entries", u, M{"local_date": "2026-10-17", "items": []M{{"dish_id": dish, "qty": qty, "unit": unit, "source": "table", "confirmed": true}}}, out)
	}
	// the Tester's repros: protein column overflow (500 before) and the kurkure day poison
	for _, d := range []string{"protein_shake", "almonds", "muscleblaze_whey", "kurkure", "makhana", "papad"} {
		var e M
		if c := post(d, 5000, "plate", &e); c != 400 || e["error"] != "item 0: That’s too much for one entry. Try a smaller amount." {
			t.Errorf("%s x5000 plate: %d %v", d, c, e)
		}
	}
	var e M
	if c := post("kurkure", 3000, "plate", &e); c != 400 {
		t.Errorf("kurkure x3000 plate: %d %v", c, e)
	}
	// big but under the ceiling still saves (60 roti = 6,600 kcal)
	var cr struct{ Entries []entry }
	if c := post("roti", 60, "count", &cr); c != 201 || cr.Entries[0].KcalBest > 10000 {
		t.Fatalf("60 roti: %d %+v", c, cr)
	}
	big := cr.Entries[0].ID
	// later saves of that day are fine and list == summary
	for i := 0; i < 3; i++ {
		if c := post("dal", 1, "katori", nil); c != 201 {
			t.Errorf("later save %d: %d", i, c)
		}
	}
	tot, sum, n := dayOf(t, u, get)
	if tot != sum || n != 4 {
		t.Errorf("list %v != summary %v (rows %d)", tot, sum, n)
	}
	// PATCH: past the ceiling is the same readable 400; the row keeps its value
	if c := call(t, srv, "PATCH", fmt.Sprintf("/v1/entries/%d", big), u, M{"qty": 5000}, &e); c != 400 || e["error"] != "That’s too much for one entry. Try a smaller amount." {
		t.Errorf("PATCH 5000 roti: %d %v", c, e)
	}
	if c := call(t, srv, "PATCH", fmt.Sprintf("/v1/entries/%d", big), u, M{"dish_id": "kurkure", "qty": 5000, "unit": "plate"}, &e); c != 400 {
		t.Errorf("PATCH to 5000 plate kurkure: %d %v", c, e)
	}
	if tot2, sum2, _ := dayOf(t, u, get); tot2 != tot || sum2 != sum {
		t.Errorf("a refused PATCH changed the day: %v/%v -> %v/%v", tot, sum, tot2, sum2)
	}
	// all or nothing: make the summary unwritable above 9,000 kcal (a stand-in for any
	// summary failure). The save that would need it is refused and NOT committed.
	if _, err := pool.Exec(context.Background(), `ALTER TABLE daily_summaries ADD CONSTRAINT h1_test_cap CHECK (kcal_in < 9000)`); err != nil {
		t.Fatal(err)
	}
	if c := post("roti", 25, "count", &e); c != 400 || e["error"] != "That’s too much for one day. Try a smaller amount." {
		t.Errorf("summary refused: %d %v", c, e)
	}
	if c := call(t, srv, "PATCH", fmt.Sprintf("/v1/entries/%d", big), u, M{"qty": 80}, &e); c != 400 {
		t.Errorf("PATCH needing an unwritable summary: %d %v", c, e)
	}
	if tot3, sum3, n3 := dayOf(t, u, get); tot3 != tot || sum3 != sum || n3 != 4 {
		t.Errorf("a refused write left a row behind: list %v summary %v rows %d (want %v / %v / 4)", tot3, sum3, n3, tot, sum)
	}
	_, _ = pool.Exec(context.Background(), `ALTER TABLE daily_summaries DROP CONSTRAINT h1_test_cap`)
	if c := post("dal", 1, "katori", nil); c != 201 {
		t.Errorf("save after: %d", c)
	}
	if tot4, sum4, n4 := dayOf(t, u, get); tot4 != sum4 || n4 != 5 {
		t.Errorf("list %v != summary %v (rows %d)", tot4, sum4, n4)
	}
}
