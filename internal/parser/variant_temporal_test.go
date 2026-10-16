package parser

import (
	"testing"

	"github.com/akarsh/calorie-tracker/internal/dishes"
)

func mustParser(t *testing.T) *Parser {
	t.Helper()
	p, err := New(dishes.MustLoad())
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func has(fl []string, f string) bool {
	for _, x := range fl {
		if x == f {
			return true
		}
	}
	return false
}

// A bare base dish whose variants differ >15% kcal is never guessed.
func TestVariantChoiceBiryani(t *testing.T) {
	p := mustParser(t)
	for _, tc := range []struct {
		text string
		qty  float64
		veg  float64
	}{{"biryani", 1, 400}, {"aadha plate biryani", 0.5, 200}, {"adha plate biryani", 0.5, 200}, {"half plate biryani", 0.5, 200}} {
		r := p.Parse(tc.text)
		if len(r.Items) != 1 {
			t.Fatalf("%q: %+v", tc.text, r.Items)
		}
		it := r.Items[0]
		if !it.NeedsConfirmation || it.OneTapOK || !has(it.Flags, "variant_choice") || len(it.VariantOptions) != 4 || it.Quantity != tc.qty {
			t.Errorf("%q: %+v", tc.text, it)
		}
		for _, o := range it.VariantOptions {
			if o.DishID == "veg_biryani" && o.Kcal != tc.veg {
				t.Errorf("%q veg at portion: %v", tc.text, o.Kcal)
			}
		}
	}
	for _, s := range []string{"chicken biryani", "half plate veg biryani", "mutton biryani", "anda biryani"} {
		it := p.Parse(s).Items[0]
		if has(it.Flags, "variant_choice") || !it.OneTapOK {
			t.Errorf("%q named a variant: %+v", s, it)
		}
	}
	if v := p.Variants(); len(v["biryani"]) != 4 {
		t.Errorf("variants: %v", v)
	}
}

// Time words say when, not what: no forced confirm.
func TestTemporalWordsStripped(t *testing.T) {
	p := mustParser(t)
	for _, s := range []string{"kal ka rajma", "bacha hua rajma", "aaj ka rajma", "kal ki dal"} {
		r := p.Parse(s)
		if len(r.Items) != 1 || r.Leftover != 0 || len(r.Unmatched) != 0 || !r.Items[0].OneTapOK {
			t.Errorf("%q: %+v %+v", s, r.Items, r.Unmatched)
		}
	}
	// truly unknown words still force confirm
	r := p.Parse("kal ka rajma zorbali")
	if !r.Items[0].NeedsConfirmation || r.Items[0].OneTapOK {
		t.Errorf("unknown word: %+v", r.Items[0])
	}
}

// Vague amounts are not filler: they force confirm until mapped; oil levels stay mapped.
func TestVagueQuantityForcesConfirm(t *testing.T) {
	p := mustParser(t)
	for _, s := range []string{"thoda rajma", "zyada chawal", "bahut dal"} {
		it := p.Parse(s).Items[0]
		if !it.NeedsConfirmation || it.OneTapOK || !has(it.Flags, "vague_quantity") {
			t.Errorf("%q: %+v", s, it)
		}
	}
	if it := p.Parse("zyada tel wali bhindi").Items[0]; has(it.Flags, "vague_quantity") {
		t.Errorf("oil level is mapped: %+v", it)
	}
}
