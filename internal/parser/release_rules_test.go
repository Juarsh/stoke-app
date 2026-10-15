package parser

import (
	"slices"
	"testing"
)

// Release rules after the e672dbe run.
func TestReleaseRules(t *testing.T) {
	p := newP(t)
	flagged := func(s, flag string) {
		t.Helper()
		r := p.Parse(s)
		ok := false
		for _, it := range r.Items {
			ok = ok || slices.Contains(it.Flags, flag) && it.NeedsConfirmation
		}
		if !ok {
			t.Errorf("%q: want a %s item needing confirmation, got %+v", s, flag, r.Items)
		}
	}
	// 1) fractional portions scale every combo part and ask
	for _, s := range []string{"half plate chole bhature", "aadha plate chole bhature", "1/2 plate chole bhature", "dedh plate chole bhature"} {
		flagged(s, "fractional_combo")
	}
	r := p.Parse("half plate chole bhature")
	if len(r.Items) != 2 || r.Items[0].Quantity != 0.5 || r.Items[1].Quantity != 1 {
		t.Errorf("half plate must halve each part: %+v", r.Items)
	}
	if r := p.Parse("1 plate chole bhature"); r.Items[0].NeedsConfirmation {
		t.Errorf("whole plate stays confident: %+v", r.Items)
	}
	// 2) an unknown word glued to a dish: whole phrase is unsure
	for _, s := range []string{"kuttu cheela", "roti zorbo", "zorbo roti"} {
		flagged(s, "leftover_nearby")
	}
	// 3) egg counts on a bowl dish: base bowl + extra egg pieces, flagged
	for _, s := range []string{"egg curry 3 eggs", "3 ande ki curry", "3 anda curry", "4 egg curry"} {
		r := p.Parse(s)
		var kcal float64
		ids := []string{}
		for _, it := range r.Items {
			kcal += it.Kcal.Best
			ids = append(ids, it.DishID)
			if !slices.Contains(it.Flags, "egg_count") || !it.NeedsConfirmation {
				t.Errorf("%q: egg_count must flag: %+v", s, it)
			}
		}
		if !slices.Contains(ids, "egg_curry") || !slices.Contains(ids, "boiled_egg") || kcal <= 220 {
			t.Errorf("%q: want egg_curry + boiled eggs, got %v %.0f kcal", s, ids, kcal)
		}
	}
}

// Flatbread qualifiers are never dropped: exact row, or flagged.
func TestFlatbreadQualifiers(t *testing.T) {
	p := newP(t)
	for _, s := range []string{"ragi roti", "makki roti", "makki ki roti", "bajra roti", "jowar roti", "missi roti"} {
		r := p.Parse(s)
		for _, it := range r.Items {
			if it.DishID == "roti" && !it.NeedsConfirmation {
				t.Errorf("%q read confidently as plain roti: %+v", s, it)
			}
		}
	}
}
