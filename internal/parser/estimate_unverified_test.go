package parser

import (
	"slices"
	"testing"
)

// bhel_puri's sources disagree: it parses as the dish (no AI) but is never confident.
func TestEstimateUnverifiedNeverConfident(t *testing.T) {
	p := newP(t)
	for _, s := range []string{"bhel puri", "1 plate bhel puri", "2 roti, 1 bhel puri"} {
		found := false
		for _, it := range p.Parse(s).Items {
			if it.DishID != "bhel_puri" {
				continue
			}
			found = true
			if !it.NeedsConfirmation || it.Source == SourceTable || !slices.Contains(it.Flags, "estimate_unverified") {
				t.Errorf("%q: bhel_puri must need confirmation with estimate_unverified, got source=%s flags=%v", s, it.Source, it.Flags)
			}
		}
		if !found {
			t.Errorf("%q: bhel_puri not parsed", s)
		}
	}
}
