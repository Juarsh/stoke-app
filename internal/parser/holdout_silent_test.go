package parser

import (
	"slices"
	"testing"
)

// Holdout 1 (H13): a bare Kurkure packet must land in the gold range from a
// real brand-label pack size — never a silently-wrong 50 g / 270 kcal save.
func TestKurkurePacketBrandLabel(t *testing.T) {
	p := newP(t)
	for _, s := range []string{"kurkure 1 packet", "1 packet kurkure", "kurkure"} {
		r := p.Parse(s)
		if len(r.Items) != 1 {
			t.Fatalf("%q: want 1 item, got %+v", s, r)
		}
		it := r.Items[0]
		if it.DishID != "kurkure" || it.NeedsConfirmation || !it.OneTapOK || it.Source != SourceTable {
			t.Fatalf("%q: want confident table kurkure, got %+v", s, it)
		}
		if it.Kcal.Best < 126 || it.Kcal.Best > 176 {
			t.Errorf("%q: kcal %.0f outside 126–176 (brand-label packet)", s, it.Kcal.Best)
		}
		if it.Protein.Best < 1.3 || it.Protein.Best > 2.9 {
			t.Errorf("%q: protein %.1f outside 1.3–2.9 g", s, it.Protein.Best)
		}
		if it.Grams < 25 || it.Grams > 35 {
			t.Errorf("%q: grams %.0f not a real small packet (~28 g)", s, it.Grams)
		}
	}
}

// Holdout 2 (J03): puttu kadala curry must never silently save as puttu-only.
// Kadala curry is its own table row; adjacent with no separator → compound_name
// (everyday pairs stay frozen). Totals land in the gold range once confirmed.
func TestPuttuKadalaCurryNoSilentDrop(t *testing.T) {
	p := newP(t)
	r := p.Parse("puttu kadala curry")
	if len(r.Items) != 2 {
		t.Fatalf("want puttu + kadala_curry, got %+v unmatched %v", r.Items, r.Unmatched)
	}
	ids := []string{r.Items[0].DishID, r.Items[1].DishID}
	if !slices.Contains(ids, "puttu") || !slices.Contains(ids, "kadala_curry") {
		t.Fatalf("want puttu + kadala_curry, got %v", ids)
	}
	kcal, prot := 0.0, 0.0
	for _, it := range r.Items {
		if !it.NeedsConfirmation || it.OneTapOK {
			t.Errorf("%s: must need confirmation (no silent complete save), got confirm=%v one_tap=%v flags=%v",
				it.DishID, it.NeedsConfirmation, it.OneTapOK, it.Flags)
		}
		if !slices.Contains(it.Flags, "compound_name") && !slices.Contains(it.Flags, "leftover_in_meal") && !slices.Contains(it.Flags, "leftover_nearby") {
			t.Errorf("%s: want compound_name or leftover flag, got %v", it.DishID, it.Flags)
		}
		kcal += it.Kcal.Best
		prot += it.Protein.Best
	}
	if kcal < 342 || kcal > 616 {
		t.Errorf("total kcal %.0f outside 342–616", kcal)
	}
	if prot < 11 || prot > 23 {
		t.Errorf("total protein %.1f outside 11–23 g", prot)
	}
}

// General leftover rule: any unmatched food word forces needs_confirmation
// and blocks one_tap_ok. A silent drop of a missing side is a silent wrong save.
func TestLeftoverUnmatchedForcesConfirmation(t *testing.T) {
	p := newP(t)
	cases := []string{
		"roti quinoa",          // unknown side next to a table dish
		"2 roti dal xyz",       // trailing unknown token
		"dal curry",            // form word that does not change the dish
		"puttu mystery side",   // missing side not in the table
	}
	for _, s := range cases {
		r := p.Parse(s)
		if len(r.Items) == 0 {
			t.Fatalf("%q: want at least one item", s)
		}
		if r.Leftover == 0 && len(r.Unmatched) == 0 {
			t.Fatalf("%q: want unmatched leftover words, got %+v", s, r)
		}
		for _, it := range r.Items {
			if !it.NeedsConfirmation {
				t.Errorf("%q / %s: leftover must force needs_confirmation, flags=%v", s, it.DishID, it.Flags)
			}
			if it.OneTapOK {
				t.Errorf("%q / %s: leftover must not be one_tap_ok", s, it.DishID)
			}
			if !slices.Contains(it.Flags, "leftover_in_meal") && !slices.Contains(it.Flags, "leftover_nearby") {
				t.Errorf("%q / %s: want leftover_in_meal or leftover_nearby, got %v", s, it.DishID, it.Flags)
			}
		}
	}
}
