package parser

import "testing"

// Adjacent table matches that read like one dish name are never two
// confident items; listed combos and dish pairs still split.
func TestCompoundNamesNeverSplitConfidently(t *testing.T) {
	p := newP(t)
	for _, s := range []string{"egg rice", "chicken rice", "2 paneer roti", "1 plate chicken pulao", "anda paratha roti", "sabzi biscuit", "dal chai", "poha sambar"} {
		for _, it := range p.Parse(s).Items {
			if it.Source == SourceTable || !it.NeedsConfirmation {
				t.Errorf("%q: confident split item %+v", s, it)
			}
		}
	}
	for _, s := range []string{"egg rice", "chicken rice", "dal chai"} {
		for _, it := range p.Parse(s).Items {
			if !hasF(it.Flags, "compound_name") {
				t.Errorf("%q: no compound_name: %+v", s, it.Flags)
			}
		}
	}
	for _, s := range []string{"idli aur sambar", "2 roti, 1 katori dal", "1 egg aur 1 katori rice", "dal chawal", "rajma chawal", "roti sabzi", "idli sambar", "chai biscuit", "bread omelette"} {
		for _, it := range p.Parse(s).Items {
			if hasF(it.Flags, "compound_name") {
				t.Errorf("%q: separated dishes flagged compound: %+v", s, it)
			}
		}
	}
}
