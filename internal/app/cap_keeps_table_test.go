package app

import (
	"fmt"
	"testing"
)

// When the AI cap is hit, known table dishes stay resolved; only the unknown
// span needs the user's input.
func TestCapKeepsTableDishes(t *testing.T) {
	srv, _ := setup(t, &fakeAI{})
	call(t, srv, "POST", "/test/ai/calls/reset", "", nil, nil)
	for i := 0; i < 3; i++ {
		parseAI(t, srv, "capk", fmt.Sprintf("zorb meal %d", i))
	}
	c, r := parseAI(t, srv, "capk", "roti zorbali")
	if c != 200 || r.FallbackReason != "user_limit" || r.AIState != "failed" || len(r.Items) != 1 || r.Items[0].DishID != "roti" ||
		len(r.FailedSpans) != 1 || r.FailedSpans[0]["text"] != "zorbali" || !r.NeedsConfirmation {
		t.Errorf("cap hit: %d %+v", c, r)
	}
}

// A queued meal that ends failed keeps its table dishes too.
func TestQueuedFailKeepsTableDishes(t *testing.T) {
	srv, _ := setup(t, &fakeAI{})
	for i, mode := range []string{"error", "daily_limit"} {
		call(t, srv, "POST", "/test/ai/calls/reset", "", nil, nil)
		call(t, srv, "POST", "/test/ai/fail", "", M{"mode": mode}, nil)
		_, r := parseAI(t, srv, fmt.Sprintf("qf%d", i), "roti zorbali")
		if r.AIState != "failed" || len(r.Items) != 1 || r.Items[0].DishID != "roti" || !r.NeedsConfirmation ||
			len(r.FailedSpans) != 1 || r.FailedSpans[0]["text"] != "zorbali" || len(r.CustomItems) != 1 {
			t.Errorf("%s: %+v", mode, r)
		}
	}
	call(t, srv, "POST", "/test/ai/fail", "", M{"mode": ""}, nil)
}

func TestVariantRequiredOnSave(t *testing.T) {
	srv, _ := setup(t, &fakeAI{})
	base := func(extra M) M {
		m := M{"dish_id": "chicken_biryani", "qty": 0.5, "unit": "plate", "source": "table", "span": "biryani", "client_id": fmt.Sprint(len(extra), extra["variant_dish_id"])}
		for k, v := range extra {
			m[k] = v
		}
		return m
	}
	var body M
	if c := call(t, srv, "POST", "/v1/entries", "vr", M{"text": "aadha plate biryani", "items": []M{base(M{})}}, &body); c != 422 || errCode(body) != "variant_required" {
		t.Errorf("default chicken without a choice: %d %+v", c, body)
	} else if opts, _ := body["error"].(map[string]any)["variant_options"].([]any); len(opts) != 4 {
		t.Errorf("options: %+v", body)
	}
	if c := call(t, srv, "POST", "/v1/entries", "vr", M{"items": []M{base(M{"variant_dish_id": "veg_biryani"})}}, &body); c != 422 {
		t.Errorf("variant_dish_id != dish_id: %d", c)
	}
	if c := call(t, srv, "POST", "/v1/entries", "vr", M{"items": []M{base(M{"variant_dish_id": "chicken_biryani"})}}, nil); c != 201 {
		t.Errorf("picked chicken: %d", c)
	}
	v := base(M{"variant_dish_id": "veg_biryani"})
	v["dish_id"] = "veg_biryani"
	if c := call(t, srv, "POST", "/v1/entries", "vr", M{"items": []M{v}}, nil); c != 201 {
		t.Errorf("picked veg: %d", c)
	}
	// a named variant needs no choice
	if c := call(t, srv, "POST", "/v1/entries", "vr", M{"items": []M{{"dish_id": "veg_biryani", "qty": 1, "unit": "plate", "source": "table", "span": "veg biryani", "client_id": "nv"}}}, nil); c != 201 {
		t.Errorf("named variant: %d", c)
	}
}

func TestVagueQuantityNeedsConfirmOnSave(t *testing.T) {
	srv, _ := setup(t, &fakeAI{})
	item := M{"dish_id": "rajma", "qty": 0.5, "unit": "katori", "source": "table", "span": "thoda rajma", "client_id": "vq1"}
	var body M
	if c := call(t, srv, "POST", "/v1/entries", "vq", M{"items": []M{item}}, &body); c != 422 || errCode(body) != "quantity_required" {
		t.Errorf("vague one-tap: %d %+v", c, body)
	}
	item["confirmed"] = true
	if c := call(t, srv, "POST", "/v1/entries", "vq", M{"items": []M{item}}, nil); c != 201 {
		t.Errorf("confirmed: %d", c)
	}
	// text-only batch save never one-taps it
	var tb struct {
		Entries           []M
		NeedsConfirmation []M `json:"needs_confirmation"`
	}
	call(t, srv, "POST", "/v1/entries", "vq", M{"text": "thoda rajma"}, &tb)
	if len(tb.Entries) != 0 || len(tb.NeedsConfirmation) != 1 {
		t.Errorf("text batch: %+v", tb)
	}
}

func errCode(b M) string {
	e, _ := b["error"].(map[string]any)
	c, _ := e["code"].(string)
	return c
}
