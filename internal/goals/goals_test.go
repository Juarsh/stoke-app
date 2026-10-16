package goals

import "testing"

func valid() ProfileIn {
	// 30y, 175 cm, 80 kg, moderate: maintenance female 2453, male 2711; midpoint 2582
	return ProfileIn{TargetKcal: 2082, MaintenanceKcal: 2582, Goal: "fat_loss", Diet: "veg", Age: 30, HeightCM: 175, WeightKG: 80, ActivityLevel: "moderate"}
}

func TestProfileValidate(t *testing.T) {
	if bad := valid().Validate(); len(bad) != 0 {
		t.Fatalf("valid: %v", bad)
	}
	lo, hi := MaintenanceRange(30, 175, 80, "moderate")
	cases := map[string]func(*ProfileIn){
		"target_kcal":      func(p *ProfileIn) { p.TargetKcal = 1199 },
		"maintenance_kcal": func(p *ProfileIn) { p.MaintenanceKcal = hi + 3 },
		"maintenance_lo":   func(p *ProfileIn) { p.MaintenanceKcal = lo - 3 },
		"cut":              func(p *ProfileIn) { p.TargetKcal = 2079 },
		"age":              func(p *ProfileIn) { p.Age = 5 },
	}
	for name, mod := range cases {
		p := valid()
		mod(&p)
		if len(p.Validate()) == 0 {
			t.Errorf("%s: accepted %+v", name, p)
		}
	}
	// rounding tolerance and both formula ends
	for _, m := range []float64{lo - 2, hi + 2, lo, hi} {
		p := valid()
		p.MaintenanceKcal, p.TargetKcal = m, int(m)
		if bad := p.Validate(); len(bad) != 0 {
			t.Errorf("maintenance %v: %v", m, bad)
		}
	}
	if m := Macros(2082, 80, "fat_loss"); m.Kcal != 2082 || m.ProteinG != 128 {
		t.Errorf("macros keep the phone's target: %+v", m)
	}
}
