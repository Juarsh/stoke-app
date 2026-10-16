package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestProfileValidationAndNoSex(t *testing.T) {
	srv, pool := setup(t, &fakeAI{})
	ok := M{"sex": "female", "age": 30, "height_cm": 175, "weight_kg": 80, "activity_level": "moderate", "goal": "fat_loss",
		"diet": "veg", "maintenance_kcal": 2582, "target_kcal": 2082}
	var out struct {
		Profile M
		Target  struct{ Kcal int }
	}
	if c := call(t, srv, "PUT", "/v1/profile", "pf", ok, &out); c != 200 || out.Target.Kcal != 2082 {
		t.Fatalf("valid: %d %+v", c, out)
	}
	if _, has := out.Profile["sex"]; has {
		t.Errorf("sex echoed: %+v", out.Profile)
	}
	// the column is gone and nothing stored mentions it
	var n int
	pool.QueryRow(context.Background(), `SELECT count(*) FROM information_schema.columns WHERE table_name='profiles' AND column_name='sex'`).Scan(&n)
	if n != 0 {
		t.Errorf("profiles.sex column still exists")
	}
	var row string
	pool.QueryRow(context.Background(), `SELECT row_to_json(p)::text FROM profiles p JOIN users u ON u.id=p.user_id LIMIT 1`).Scan(&row)
	if strings.Contains(row, "female") || strings.Contains(row, "sex") {
		t.Errorf("stored: %s", row)
	}
	var me M
	call(t, srv, "GET", "/v1/me", "pf", nil, &me)
	if strings.Contains(strings.ToLower(toJSON(me)), "sex") {
		t.Errorf("me: %+v", me)
	}
	for name, kv := range map[string][2]any{
		"floor":      {"target_kcal", 1150},
		"cut":        {"target_kcal", 2070},
		"maint_high": {"maintenance_kcal", 2800},
		"maint_low":  {"maintenance_kcal", 2400},
	} {
		m := M{}
		for k, v := range ok {
			m[k] = v
		}
		m[kv[0].(string)] = kv[1]
		var body M
		if c := call(t, srv, "PUT", "/v1/profile", "pf", m, &body); c != 422 || errCode(body) != "profile_invalid" {
			t.Errorf("%s: %d %+v", name, c, body)
		}
	}
}

func toJSON(v any) string { b, _ := json.Marshal(v); return string(b) }
