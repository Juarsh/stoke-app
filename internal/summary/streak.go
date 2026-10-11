package summary

import "time"

// Streak rules (spec v2): a day counts when at least one item is logged
// (IST). One freeze per Monday-Sunday week is used automatically to bridge a
// single missed day; unused freezes don't carry over. A frozen day keeps the
// streak alive but does not add to it. Today not being logged yet never breaks it.
type Streak struct {
	Current     int     `json:"current"`
	Best        int     `json:"best"`
	FreezesLeft int     `json:"freezes_left"` // this week
	LoggedToday bool    `json:"logged_today"`
	FreezeSaved *string `json:"freeze_saved_on"` // most recent day a freeze bridged, for "Your freeze saved your N-day streak"
	week        time.Time
	lastLogged  *time.Time
	freezeUsed  *time.Time
}

func monday(d time.Time) time.Time {
	wd := (int(d.Weekday()) + 6) % 7
	return d.AddDate(0, 0, -wd)
}

// Compute walks the logged days (ascending, IST dates) up to today.
func Compute(logged []time.Time, today time.Time) Streak {
	st := Streak{FreezesLeft: 1, week: monday(today)}
	if len(logged) == 0 {
		return st
	}
	set := map[time.Time]bool{}
	for _, d := range logged {
		set[d] = true
	}
	last := logged[len(logged)-1]
	st.lastLogged = &last
	used := map[time.Time]bool{} // week monday -> freeze used
	cur := 0
	var frozen *time.Time
	for d := logged[0]; !d.After(today); d = d.AddDate(0, 0, 1) {
		switch {
		case set[d]:
			cur++
		case d.Equal(today):
			// not logged yet today: streak still alive
		case cur > 0 && !used[monday(d)] && set[d.AddDate(0, 0, 1)]:
			// a single missed day followed by a logged day: auto freeze
			used[monday(d)] = true
			dd := d
			frozen = &dd
		case cur > 0 && !used[monday(d)] && d.AddDate(0, 0, 1).Equal(today):
			// missed yesterday, today still open: freeze holds the streak for now
			used[monday(d)] = true
			dd := d
			frozen = &dd
		default:
			cur = 0
		}
		if cur > st.Best {
			st.Best = cur
		}
	}
	st.Current = cur
	st.LoggedToday = set[today]
	if used[st.week] {
		st.FreezesLeft = 0
	}
	if frozen != nil && cur > 0 {
		s := frozen.Format("2006-01-02")
		st.FreezeSaved = &s
		st.freezeUsed = frozen
	}
	return st
}
