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
