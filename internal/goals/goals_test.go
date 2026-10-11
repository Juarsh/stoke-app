package goals

import "testing"

func TestCompute(t *testing.T) {
	// 30y male, 175 cm, 80 kg, moderate, fat loss:
	// BMR = 800 + 1093.75 - 150 + 5 = 1748.75; x1.55 = 2710.6; -500 = 2210.6 -> 2210
	tg := Compute(Profile{Sex: "male", BirthYear: 1996, HeightCM: 175, WeightKG: 80, ActivityLevel: "moderate", Goal: "fat_loss"}, 2026)
	if tg.Kcal != 2210 || tg.ProteinG != 128 {
		t.Fatalf("got %+v", tg)
	}
	if got := tg.ProteinG*4 + tg.CarbsG*4 + tg.FatG*9; got < tg.Kcal-20 || got > tg.Kcal+20 {
		t.Errorf("macros %d don't add to kcal %d", got, tg.Kcal)
	}
	m := Compute(Profile{Sex: "female", BirthYear: 2000, HeightCM: 160, WeightKG: 55, ActivityLevel: "sedentary", Goal: "maintain"}, 2026)
	if m.ProteinG != 66 {
		t.Errorf("maintain protein 1.2 g/kg: %+v", m)
	}
	low := Compute(Profile{Sex: "female", BirthYear: 1950, HeightCM: 145, WeightKG: 40, ActivityLevel: "sedentary", Goal: "fat_loss"}, 2026)
	if low.Kcal < 1200 {
		t.Errorf("floor: %+v", low)
	}
}
