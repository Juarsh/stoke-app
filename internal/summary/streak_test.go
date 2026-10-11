package summary

import (
	"testing"
	"time"
)

func d(s string) time.Time { t, _ := time.Parse("2006-01-02", s); return t }

func days(ss ...string) []time.Time {
	var out []time.Time
	for _, s := range ss {
		out = append(out, d(s))
	}
	return out
}

func TestStreak(t *testing.T) {
	// 2026-10-12 is a Monday.
	cases := []struct {
		name       string
		logged     []time.Time
		today      string
		cur, best  int
		freezeLeft int
	}{
		{"empty", nil, "2026-10-14", 0, 0, 1},
		{"three in a row, today logged", days("2026-10-12", "2026-10-13", "2026-10-14"), "2026-10-14", 3, 3, 1},
		{"today not yet logged keeps streak", days("2026-10-12", "2026-10-13"), "2026-10-14", 2, 2, 1},
		{"one miss bridged by freeze", days("2026-10-12", "2026-10-14", "2026-10-15"), "2026-10-15", 3, 3, 0},
		{"missed yesterday, freeze holds", days("2026-10-12", "2026-10-13"), "2026-10-15", 2, 2, 0},
		{"two misses break", days("2026-10-12", "2026-10-13", "2026-10-16"), "2026-10-16", 1, 2, 1},
		{"second miss same week breaks", days("2026-10-12", "2026-10-14", "2026-10-16"), "2026-10-16", 1, 2, 0},
		{"new week new freeze", days("2026-10-16", "2026-10-18", "2026-10-20", "2026-10-21"), "2026-10-21", 4, 4, 0},
	}
	for _, c := range cases {
		st := Compute(c.logged, d(c.today))
		if st.Current != c.cur || st.Best != c.best || st.FreezesLeft != c.freezeLeft {
			t.Errorf("%s: got cur=%d best=%d freezes=%d, want %d %d %d", c.name, st.Current, st.Best, st.FreezesLeft, c.cur, c.best, c.freezeLeft)
		}
	}
}
