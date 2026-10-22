package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/akarsh/calorie-tracker/internal/httpx"
)

type memSessions map[string]struct {
	uid int64
	exp time.Time
}

func (m memSessions) Create(_ context.Context, h []byte, uid int64, exp time.Time) error {
	m[string(h)] = struct {
		uid int64
		exp time.Time
	}{uid, exp}
	return nil
}
func (m memSessions) User(_ context.Context, h []byte, now time.Time) (int64, error) {
	s, ok := m[string(h)]
	if !ok || !now.Before(s.exp) {
		return 0, ErrNoSession
	}
	return s.uid, nil
}
func (m memSessions) Delete(_ context.Context, h []byte) error { delete(m, string(h)); return nil }

type oneUser struct{}

func (oneUser) Upsert(context.Context, Identity) (int64, error) { return 7, nil }

func post(t *testing.T, h http.Handler, path, bearer, body string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest("POST", path, bytes.NewBufferString(body))
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	out := map[string]any{}
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func code(m map[string]any) string {
	e, _ := m["error"].(map[string]any)
	c, _ := e["code"].(string)
	return c
}

// GOOGLE_CLIENT_IDS=pending (a placeholder) says "not set up"; a real client id with a garbage token says why it's invalid.
func TestSignInReasons(t *testing.T) {
	for _, tc := range []struct {
		ids, want string
	}{{"pending", "google_not_configured"}, {"x.apps.googleusercontent.com", "invalid_token"}} {
		mux := http.NewServeMux()
		(&SignIn{Verifier: NewGoogleVerifier([]string{tc.ids}), Users: oneUser{}, Sessions: memSessions{}}).Routes(mux)
		c, m := post(t, mux, "/v1/auth/google", "", `{"id_token":"garbage"}`)
		if c != 401 || code(m) != tc.want {
			t.Errorf("%s: %d %v", tc.ids, c, m)
		}
		if tc.want == "invalid_token" && !strings.Contains(m["error"].(map[string]any)["message"].(string), "not a JWT") {
			t.Errorf("no reason: %v", m)
		}
	}
}

// The Android ID token's aud is the WEB client id: accepted when it is in GOOGLE_CLIENT_IDS next to the Android one.
func TestWebAudienceAccepted(t *testing.T) {
	g := NewGoogleVerifier([]string{"and.apps.googleusercontent.com", "web.apps.googleusercontent.com"})
	if !g.Configured() {
		t.Fatal("real ids not configured")
	}
	if NewGoogleVerifier([]string{"pending"}).Configured() {
		t.Fatal("placeholder configured")
	}
}

func TestSessionMiddleware(t *testing.T) {
	sess := memSessions{}
	s := &SignIn{Verifier: DevVerifier{}, Users: oneUser{}, Sessions: sess}
	mux := http.NewServeMux()
	s.Routes(mux)
	c, m := post(t, mux, "/v1/auth/google", "", `{"id_token":"dev:a"}`)
	tok, _ := m["session_token"].(string)
	if c != 200 || !strings.HasPrefix(tok, SessionPrefix) {
		t.Fatalf("sign in: %d %v", c, m)
	}
	if _, ok := sess[string(tokenHash(tok))]; !ok || len(sess) != 1 {
		t.Fatal("only the hash is the key")
	}
	var got int64
	h := WithSessions(DevVerifier{}, oneUser{}, sess)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { got = httpx.UserID(r) }))
	for _, tc := range []struct {
		bearer string
		code   int
	}{{tok, 200}, {"dev:a", 200}, {SessionPrefix + "nope", 401}, {"garbage", 401}, {"", 401}} {
		got = 0
		c, _ := post(t, h, "/x", tc.bearer, "")
		if c != tc.code || (c == 200 && got != 7) {
			t.Errorf("%q: %d uid %d", tc.bearer, c, got)
		}
	}
	if _, err := sess.User(context.Background(), tokenHash(tok), time.Now().Add(SessionTTL+time.Second)); err != ErrNoSession {
		t.Fatal("expired session still live")
	}
	if c, _ := post(t, mux, "/v1/auth/signout", tok, ""); c != 204 || len(sess) != 0 {
		t.Fatalf("signout: %d %d", c, len(sess))
	}
	if c, _ := post(t, h, "/x", tok, ""); c != 401 {
		t.Fatalf("after signout: %d", c)
	}
}
