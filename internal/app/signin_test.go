package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/akarsh/calorie-tracker/internal/auth"
)

func raw(t *testing.T, srv *httptest.Server, method, path, bearer string, body any) (int, map[string]any) {
	t.Helper()
	b, _ := json.Marshal(body)
	if body == nil {
		b = nil
	}
	req, _ := http.NewRequest(method, srv.URL+path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	out := map[string]any{}
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func signinCode(m map[string]any) string {
	e, _ := m["error"].(map[string]any)
	c, _ := e["code"].(string)
	return c
}

// Item 16: a Google ID token is traded once for our session; the session is the bearer from then on, same user id as
// the Google token itself maps to; sign-out revokes it; deleting the account drops it.
func TestSignInSession(t *testing.T) {
	srv, pool := setup(t, nil)
	if c, m := raw(t, srv, "POST", "/v1/auth/google", "", map[string]string{"id_token": "garbage"}); c != 401 || signinCode(m) != "invalid_token" {
		t.Fatalf("garbage token: %d %v", c, m)
	}
	if c, m := raw(t, srv, "POST", "/v1/auth/google", "", map[string]string{"id_token": " "}); c != 400 || signinCode(m) != "id_token_required" {
		t.Fatalf("empty token: %d %v", c, m)
	}
	c, m := raw(t, srv, "POST", "/v1/auth/google", "", map[string]string{"id_token": "good-s1"})
	if c != 200 {
		t.Fatalf("sign in: %d %v", c, m)
	}
	tok, _ := m["session_token"].(string)
	user, _ := m["user"].(map[string]any)
	if !strings.HasPrefix(tok, auth.SessionPrefix) || len(tok) < 40 || user["email"] != "s1@example.com" || m["expires_at"] == nil {
		t.Fatalf("sign-in body: %v", m)
	}
	var stored int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM sessions WHERE token_hash=sha256($1::bytea)`, []byte(tok)).Scan(&stored); err != nil || stored != 1 {
		t.Fatalf("hash stored: %d %v", stored, err)
	}
	var plain int
	_ = pool.QueryRow(context.Background(), `SELECT count(*) FROM sessions WHERE encode(token_hash,'escape') LIKE '%stk_%'`).Scan(&plain)
	if plain != 0 {
		t.Fatal("raw token stored")
	}
	// the session and the Google token are the same user: a change made with one is read with the other
	if c, m := raw(t, srv, "PATCH", "/v1/me", tok, map[string]any{"diet": "veg"}); c != 200 && c != 204 {
		t.Fatalf("patch me with the session: %d %v", c, m)
	}
	c2, me2 := raw(t, srv, "GET", "/v1/me", "good-s1", nil)
	var uid int64
	_ = pool.QueryRow(context.Background(), `SELECT user_id FROM user_identities WHERE subject='s1'`).Scan(&uid)
	if c2 != 200 || me2["diet"] != "veg" || me2["email"] != "s1@example.com" || user["id"] != float64(uid) {
		t.Fatalf("same user: %d %v, sign-in id %v, identity %d", c2, me2, user["id"], uid)
	}
	// a made-up session is refused with a reason
	if c, m := raw(t, srv, "GET", "/v1/me", auth.SessionPrefix+"nope", nil); c != 401 || m["error"] != "session expired or signed out" {
		t.Fatalf("unknown session: %d %v", c, m)
	}
	// sign out revokes it (twice is fine)
	for i := 0; i < 2; i++ {
		if c, _ := raw(t, srv, "POST", "/v1/auth/signout", tok, nil); c != 204 {
			t.Fatalf("signout %d: %d", i, c)
		}
	}
	if c, _ := raw(t, srv, "GET", "/v1/me", tok, nil); c != 401 {
		t.Fatalf("after signout: %d", c)
	}
	// delete account drops every session
	_, m = raw(t, srv, "POST", "/v1/auth/google", "", map[string]string{"id_token": "good-s2"})
	tok2, _ := m["session_token"].(string)
	if c, _ := raw(t, srv, "DELETE", "/v1/me", tok2, nil); c != 204 {
		t.Fatalf("delete me: %d", c)
	}
	if c, _ := raw(t, srv, "GET", "/v1/me", tok2, nil); c != 401 {
		t.Fatalf("session after delete: %d", c)
	}
}
