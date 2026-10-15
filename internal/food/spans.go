package food

import (
	"sort"
	"strings"
	"unicode"
	"unicode/utf16"

	"github.com/akarsh/calorie-tracker/internal/parser"
)

// Span is a part of the user's text, as UTF-16 offsets (end exclusive).
type Span struct {
	Start int    `json:"span_start"`
	End   int    `json:"span_end"`
	Text  string `json:"text"`
}

func u16(s string) []uint16 { return utf16.Encode([]rune(s)) }

func sub16(t []uint16, a, b int) string {
	if a < 0 || b > len(t) || a >= b {
		return ""
	}
	return string(utf16.Decode(t[a:b]))
}

// unclaimed returns the parts of text not covered by claimed items, trimmed
// of spaces/punctuation and with noise-only parts (numbers, connectors,
// fillers) dropped. With nothing claimed it is the whole text.
func unclaimed(text string, claimed []parser.Item, noise func(string) bool) []Span {
	t := u16(text)
	cover := make([]bool, len(t))
	for _, it := range claimed {
		for i := max(0, it.SpanStart); i < it.SpanEnd && i < len(t); i++ {
			cover[i] = true
		}
	}
	var out []Span
	for i := 0; i < len(t); {
		if cover[i] {
			i++
			continue
		}
		j := i
		for j < len(t) && !cover[j] {
			j++
		}
		a, b := i, j
		for a < b && isTrim(t[a]) {
			a++
		}
		for b > a && isTrim(t[b-1]) {
			b--
		}
		if a < b {
			s := sub16(t, a, b)
			if !noise(s) {
				out = append(out, Span{Start: a, End: b, Text: s})
			}
		}
		i = j
	}
	return out
}

func isTrim(c uint16) bool {
	r := rune(c)
	return unicode.IsSpace(r) || unicode.IsPunct(r) || r == '+' || r == '&'
}

func overlaps(a0, a1, b0, b1 int) bool { return a0 < b1 && b0 < a1 }

// placeAI validates AI items against the allowed spans: an item must lie
// inside one span (its span_text is searched for there first); items that
// overlap a claimed table item are dropped; items with no valid position
// become did-you-mean on the first open span (flag ai_unplaced): items with
// neither offsets nor span_text are never placed by name.
func placeAI(text string, items []parser.Item, spans []Span, claimed []parser.Item, locate func(string, string) (int, int, bool)) []parser.Item {
	var out []parser.Item
	for _, it := range items {
		ok := false
		hitsTable := false
		for _, c := range claimed {
			if it.SpanStart < it.SpanEnd && overlaps(it.SpanStart, it.SpanEnd, c.SpanStart, c.SpanEnd) &&
				!(it.SpanStart <= 0 && it.SpanEnd >= len(u16(text))) { // a whole-text answer is just unplaced
				hitsTable = true
			}
		}
		if hitsTable {
			continue // the AI answered for text a table item already claimed
		}
		// 1) the AI's own offsets, if inside an allowed span
		for _, sp := range spans {
			if it.SpanStart >= sp.Start && it.SpanEnd <= sp.End && it.SpanStart < it.SpanEnd {
				ok = true
				break
			}
		}
		// 2) otherwise find its words inside one allowed span
		if !ok {
			for _, sp := range spans {
				// only the AI's own span_text places it; never guess from the name
				for _, w := range []string{it.Matched} {
					if w == "" {
						continue
					}
					if a, b, found := locate(sp.Text, w); found {
						it.SpanStart, it.SpanEnd, ok = sp.Start+a, sp.Start+b, true
						break
					}
				}
				if ok {
					break
				}
			}
		}
		bad := false
		for _, c := range claimed {
			if ok && overlaps(it.SpanStart, it.SpanEnd, c.SpanStart, c.SpanEnd) {
				bad = true
			}
		}
		if bad {
			continue // never override a confident table item
		}
		if !ok {
			if len(spans) == 0 {
				continue
			}
			it.SpanStart, it.SpanEnd = spans[0].Start, spans[0].End
			it.Source = parser.SourceDidYouMean
			it.Flags = append(it.Flags, "ai_unplaced")
		}
		it.Matched = sub16(u16(text), it.SpanStart, it.SpanEnd)
		out = append(out, it)
	}
	return out
}

func sortBySpan(items []parser.Item) {
	sort.SliceStable(items, func(i, j int) bool { return items[i].SpanStart < items[j].SpanStart })
}

func spanKey(text string, claimed []parser.Item) string {
	var b strings.Builder
	b.WriteString(Normalize(text))
	for _, c := range claimed {
		b.WriteString("|")
		b.WriteString(c.DishID)
		b.WriteString("@")
		b.WriteString(itoa(c.SpanStart))
		b.WriteString("-")
		b.WriteString(itoa(c.SpanEnd))
	}
	return b.String()
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	neg := i < 0
	if neg {
		i = -i
	}
	var d []byte
	for i > 0 {
		d = append([]byte{byte('0' + i%10)}, d...)
		i /= 10
	}
	if neg {
		d = append([]byte{'-'}, d...)
	}
	return string(d)
}
