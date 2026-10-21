package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/akarsh/calorie-tracker/internal/httpx"
)

func TestFromConfig(t *testing.T) {
	for _, env := range []string{"production", "prod", "Production "} {
		if _, err := FromConfig("dev", env, ""); err == nil {
			t.Errorf("dev auth allowed with APP_ENV=%q", env)
		}
	}
	for _, env := range []string{"", "dev", "test", "ci"} {
		v, err := FromConfig("dev", env, "")
		if _, ok := v.(DevVerifier); err != nil || !ok {
			t.Errorf("APP_ENV=%q: %v %T", env, err, v)
		}
	}
	if _, err := FromConfig("google", "production", " , "); err == nil {
		t.Error("google auth without client ids")
	}
	v, err := FromConfig("", "production", "web.apps.googleusercontent.com, android.apps.googleusercontent.com")
	g, ok := v.(*GoogleVerifier)
	if err != nil || !ok || len(g.Audiences) != 2 || g.Audiences[1] != "android.apps.googleusercontent.com" {
		t.Fatalf("google: %v %+v", err, v)
	}
	if _, err := FromConfig("open", "", "x"); err == nil {
		t.Error("unknown AUTH_MODE accepted")
	}
}

type fakeVerifier map[string]Identity

func (f fakeVerifier) Verify(_ context.Context, tok string) (Identity, error) {
	if id, ok := f[tok]; ok {
		return id, nil
	}
	return Identity{}, ErrInvalid
}

type fakeUsers struct{ seen []Identity }

func (u *fakeUsers) Upsert(_ context.Context, id Identity) (int64, error) {
	u.seen = append(u.seen, id)
	if id.Sub == "broken" {
		return 0, errors.New("db down")
	}
	return int64(len(id.Sub)), nil
}

func TestMiddlewareWithFakeVerifier(t *testing.T) {
	users := &fakeUsers{}
	v := fakeVerifier{"good": {Sub: "1234567890", Email: "a@x.in"}, "dev": {Sub: "dev:me"}, "bad-db": {Sub: "broken"}}
	h := Middleware(v, users)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		httpx.JSON(w, 200, map[string]int64{"uid": httpx.UserID(r)})
	}))
	for _, c := range []struct {
		hdr  string
		want int
	}{{"", 401}, {"Bearer ", 401}, {"Basic good", 401}, {"Bearer nope", 401}, {"Bearer good", 200}, {"Bearer bad-db", 500}} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("GET", "/", nil)
		if c.hdr != "" {
			req.Header.Set("Authorization", c.hdr)
		}
		h.ServeHTTP(rec, req)
		if rec.Code != c.want {
			t.Errorf("%q: %d, want %d", c.hdr, rec.Code, c.want)
		}
	}
	if users.seen[0].Provider() != "google" || (Identity{Sub: "dev:me"}).Provider() != "dev" {
		t.Error("provider")
	}
}
