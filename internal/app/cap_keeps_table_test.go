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
	// keyed on the dish: even a named variant, or no span/text, must send variant_dish_id
	for k, it := range []M{
		{"dish_id": "veg_biryani", "qty": 1, "unit": "plate", "source": "table", "span": "veg biryani", "client_id": "nv"},
		{"dish_id": "chicken_biryani", "qty": 1, "unit": "plate", "source": "table", "client_id": "nospan"},
		{"dish_id": "chicken_biryani", "qty": 1, "unit": "plate", "source": "did_you_mean", "confirmed": true, "client_id": "dym"},
		{"dish_id": "besan_chilla", "qty": 2, "source": "table", "client_id": "ch"},
	} {
		var b M
		if c := call(t, srv, "POST", "/v1/entries", "vr", M{"items": []M{it}}, &b); c != 422 || errCode(b) != "variant_required" {
			t.Errorf("probe %d: %d %+v", k, c, b)
		}
		it["variant_dish_id"] = it["dish_id"]
		if c := call(t, srv, "POST", "/v1/entries", "vr", M{"items": []M{it}}, nil); c != 201 {
			t.Errorf("probe %d with variant_dish_id: %d", k, c)
		}
	}
	// text-only save: a named variant is the pick; a bare base never saves
	var ts struct {
		Entries           []M
		NeedsConfirmation []M `json:"needs_confirmation"`
	}
	call(t, srv, "POST", "/v1/entries", "vr", M{"text": "1 plate veg biryani"}, &ts)
	if len(ts.Entries) != 1 {
		t.Errorf("text veg biryani: %+v", ts)
	}
	ts.Entries, ts.NeedsConfirmation = nil, nil
	call(t, srv, "POST", "/v1/entries", "vr", M{"text": "1 plate biryani"}, &ts)
	if len(ts.Entries) != 0 || len(ts.NeedsConfirmation) != 1 {
		t.Errorf("text biryani: %+v", ts)
	}
	// non-variant dishes need nothing new
	if c := call(t, srv, "POST", "/v1/entries", "vr", M{"items": []M{{"dish_id": "roti", "qty": 2, "source": "table", "client_id": "r"}}}, nil); c != 201 {
		t.Errorf("roti: %d", c)
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

// PATCH runs the same checks: swapping a dish to chicken_biryani needs
// variant_dish_id; a new vague span needs confirmed.
func TestPatchChoiceChecks(t *testing.T) {
	srv, _ := setup(t, &fakeAI{})
	var cr struct{ Entries []M }
	if c := call(t, srv, "POST", "/v1/entries", "pc", M{"items": []M{{"dish_id": "rajma", "qty": 1, "source": "table", "client_id": "p1"}}}, &cr); c != 201 {
		t.Fatalf("create: %d", c)
	}
	path := fmt.Sprintf("/v1/entries/%v", cr.Entries[0]["id"])
	var b M
	if c := call(t, srv, "PATCH", path, "pc", M{"dish_id": "chicken_biryani"}, &b); c != 422 || errCode(b) != "variant_required" {
		t.Errorf("swap to default chicken: %d %+v", c, b)
	}
	if c := call(t, srv, "PATCH", path, "pc", M{"dish_id": "chicken_biryani", "variant_dish_id": "veg_biryani"}, &b); c != 422 {
		t.Errorf("mismatched variant: %d", c)
	}
	if c := call(t, srv, "PATCH", path, "pc", M{"dish_id": "veg_biryani", "variant_dish_id": "veg_biryani"}, nil); c != 200 {
		t.Errorf("picked veg: %d", c)
	}
	// now a variant dish: a qty-only edit must still name it
	if c := call(t, srv, "PATCH", path, "pc", M{"qty": 2}, &b); c != 422 || errCode(b) != "variant_required" {
		t.Errorf("qty edit on variant dish: %d %+v", c, b)
	}
	if c := call(t, srv, "PATCH", path, "pc", M{"dish_id": "rajma", "span": "thoda rajma"}, &b); c != 422 || errCode(b) != "quantity_required" {
		t.Errorf("vague span: %d %+v", c, b)
	}
	if c := call(t, srv, "PATCH", path, "pc", M{"dish_id": "rajma", "span": "thoda rajma", "confirmed": true, "qty": 0.5}, nil); c != 200 {
		t.Errorf("vague confirmed: %d", c)
	}
}
