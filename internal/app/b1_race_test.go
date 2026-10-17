package app

import (
	"context"
	"fmt"
	"net/http/httptest"
	"os"
	"strconv"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// rg8 B1: a DELETE or a day-move PATCH racing another write must leave every touched day's
// summary equal to its list (and to the rows). Before the fix the handlers read the row before
// the user's lock: DELETE rebuilt the row's old day, a version-less PATCH wrote the stale row.

func b1Runs() int {
	if n, err := strconv.Atoi(os.Getenv("B1_RUNS")); err == nil && n > 0 {
		return n
	}
	return 200
}

// b1Check: for each day, GET list total == GET summary kcal_in == sum of the live confirmed rows.
func b1Check(t *testing.T, srv *httptest.Server, pool *pgxpool.Pool, user string, days ...string) error {
	t.Helper()
	for _, d := range days {
		var l struct {
			Total struct{ Kcal float64 }
		}
		var sum struct {
			KcalIn float64 `json:"kcal_in"`
		}
		if c := call(t, srv, "GET", "/v1/entries?date="+d, user, nil, &l); c != 200 {
			return fmt.Errorf("list %s: %d", d, c)
		}
		if c := call(t, srv, "GET", "/v1/summary?date="+d, user, nil, &sum); c != 200 {
			return fmt.Errorf("summary %s: %d", d, c)
		}
		var rows float64
		_ = pool.QueryRow(context.Background(), `SELECT COALESCE(sum(e.kcal_best),0) FROM food_entries e JOIN users u ON u.id=e.user_id
			WHERE u.google_sub=$1 AND e.local_date=$2 AND e.deleted_at IS NULL AND e.state='confirmed'`, user, d).Scan(&rows)
		if l.Total.Kcal != sum.KcalIn || sum.KcalIn != rows {
			return fmt.Errorf("day %s: list %v summary %v rows %v", d, l.Total.Kcal, sum.KcalIn, rows)
		}
	}
	return nil
}

func b1Post(t *testing.T, srv *httptest.Server, user, day, cid string) {
	t.Helper()
	if c := call(t, srv, "POST", "/v1/entries", user, M{"local_date": day, "items": []M{{"custom_name": "roti", "source": "custom", "confirmed": true,
		"kcal": 110, "protein_g": 3, "client_id": cid}}}, nil); c != 201 {
		t.Fatalf("post %s: %d", cid, c)
	}
}

// run fires the ops at once and returns their statuses
func b1Race(t *testing.T, srv *httptest.Server, user string, ops []struct {
	method, path string
	body         M
}) []int {
	var wg sync.WaitGroup
	out := make([]int, len(ops))
	start := make(chan struct{})
	for i, op := range ops {
		wg.Add(1)
		go func(i int, method, path string, body M) {
			defer wg.Done()
			<-start
			out[i] = call(t, srv, method, path, user, body, nil)
		}(i, op.method, op.path, op.body)
	}
	close(start)
	wg.Wait()
	return out
}

type b1Op = struct {
	method, path string
	body         M
}

func ok(codes []int) error {
	for _, c := range codes {
		if c != 200 && c != 204 && c != 404 && c != 409 {
			return fmt.Errorf("status %d in %v", c, codes)
		}
	}
	return nil
}

// Tester's repro: save 1 roti on 10-17, then concurrently PATCH {local_date: 10-16} (with and
// without version) + DELETE. Every run: both days list == summary == rows.
func TestB1DayMoveRacingDelete(t *testing.T) {
	srv, pool := setup(t, nil)
	n := b1Runs()
	bad := 0
	for i := 0; i < n; i++ {
		user := fmt.Sprintf("b1md%d", i%20) // users reused: days carry earlier runs' (deleted/moved) rows too
		cid := fmt.Sprintf("md%d", i)
		b1Post(t, srv, user, "2026-10-17", cid)
		move := M{"local_date": "2026-10-16"}
		if i%2 == 1 {
			move["version"] = 1
		}
		codes := b1Race(t, srv, user, []b1Op{{"PATCH", "/v1/entries/" + cid, move}, {"DELETE", "/v1/entries/" + cid, nil}})
		if err := ok(codes); err != nil {
			t.Errorf("run %d: %v", i, err)
		}
		if err := b1Check(t, srv, pool, user, "2026-10-17", "2026-10-16"); err != nil {
			bad++
			t.Errorf("run %d (version=%v) %v: %v", i, i%2 == 1, codes, err)
		}
		var alive int
		_ = pool.QueryRow(context.Background(), `SELECT count(*) FROM food_entries WHERE client_id=$1 AND deleted_at IS NULL`, cid).Scan(&alive)
		if alive != 0 {
			t.Errorf("run %d: the deleted row is alive", i)
		}
	}
	t.Logf("day-move PATCH + DELETE: %d runs (half with version), %d stale summaries", n, bad)
}

// Two DELETEs of one row: both 204 (or 404), the row's day is rebuilt once, list == summary.
func TestB1DeleteRacingDelete(t *testing.T) {
	srv, pool := setup(t, nil)
	n := b1Runs()
	bad := 0
	for i := 0; i < n; i++ {
		user := fmt.Sprintf("b1dd%d", i%20)
		cid := fmt.Sprintf("dd%d", i)
		b1Post(t, srv, user, "2026-10-17", cid)
		// a day-move first, so the delete's day is the moved one
		if i%2 == 1 {
			if c := call(t, srv, "PATCH", "/v1/entries/"+cid, user, M{"local_date": "2026-10-15"}, nil); c != 200 {
				t.Fatalf("move: %d", c)
			}
		}
		codes := b1Race(t, srv, user, []b1Op{{"DELETE", "/v1/entries/" + cid, nil}, {"DELETE", "/v1/entries/" + cid, nil}, {"DELETE", "/v1/entries/" + cid, nil}})
		for _, c := range codes {
			if c != 204 && c != 404 {
				t.Errorf("run %d: delete %v", i, codes)
			}
		}
		if err := b1Check(t, srv, pool, user, "2026-10-17", "2026-10-15"); err != nil {
			bad++
			t.Errorf("run %d: %v", i, err)
		}
	}
	t.Logf("DELETE x3: %d runs, %d stale summaries", n, bad)
}

// PATCH vs PATCH: two day-moves to different days, and a day-move vs a qty/kcal edit, all
// version-less: the row ends on one day with the last edit's numbers merged onto the moved
// row (no lost move), and every touched day's list == summary == rows.
func TestB1PatchRacingPatchDayMoves(t *testing.T) {
	srv, pool := setup(t, nil)
	n := b1Runs()
	bad := 0
	days := []string{"2026-10-17", "2026-10-16", "2026-10-15"}
	for i := 0; i < n; i++ {
		user := fmt.Sprintf("b1pp%d", i%20)
		cid := fmt.Sprintf("pp%d", i)
		b1Post(t, srv, user, "2026-10-17", cid)
		var ops []b1Op
		if i%2 == 0 {
			ops = []b1Op{{"PATCH", "/v1/entries/" + cid, M{"local_date": "2026-10-16"}}, {"PATCH", "/v1/entries/" + cid, M{"local_date": "2026-10-15"}}}
		} else {
			ops = []b1Op{{"PATCH", "/v1/entries/" + cid, M{"local_date": "2026-10-16"}}, {"PATCH", "/v1/entries/" + cid, M{"kcal": 330, "custom_name": "roti"}}}
		}
		codes := b1Race(t, srv, user, ops)
		for _, c := range codes {
			if c != 200 {
				t.Errorf("run %d: version-less patches must both apply: %v", i, codes)
			}
		}
		if err := b1Check(t, srv, pool, user, days...); err != nil {
			bad++
			t.Errorf("run %d: %v", i, err)
		}
		if i%2 == 1 { // both edits kept: moved AND 330
			var d string
			var k float64
			_ = pool.QueryRow(context.Background(), `SELECT local_date::text, kcal_best FROM food_entries WHERE client_id=$1`, cid).Scan(&d, &k)
			if d != "2026-10-16" || k != 330 {
				bad++
				t.Errorf("run %d: lost update: day %s kcal %v", i, d, k)
			}
		}
	}
	t.Logf("PATCH vs PATCH day-moves: %d runs, %d stale summaries / lost updates", n, bad)
}
