package app

import "testing"

// bhel_puri (estimate_unverified) is never saved as a confident table item.
func TestEstimateUnverifiedSave(t *testing.T) {
	srv, _ := setup(t, nil)
	if c := call(t, srv, "POST", "/v1/entries", "eu", M{"items": []M{{"dish_id": "bhel_puri", "qty": 1, "unit": "plate", "source": "table",
		"dish_table_version": 2, "client_id": "b1"}}}, nil); c != 400 {
		t.Fatalf("unconfirmed bhel_puri table save: want 400, got %d", c)
	}
	if c := call(t, srv, "POST", "/v1/entries", "eu", M{"items": []M{{"dish_id": "bhel_puri", "qty": 1, "unit": "plate", "source": "table",
		"dish_table_version": 2, "confirmed": true, "client_id": "b2"}}}, nil); c != 201 {
		t.Fatalf("confirmed bhel_puri: want 201, got %d", c)
	}
}
