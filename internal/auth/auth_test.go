package auth

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Signs tokens with a local key served from a fake JWKS endpoint (no network).
func TestGoogleVerifier(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	b64 := base64.RawURLEncoding.EncodeToString
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{"kid": "k1",
			"n": b64(key.N.Bytes()), "e": b64(big.NewInt(int64(key.E)).Bytes())}}})
	}))
	defer srv.Close()
	sign := func(claims map[string]any) string {
		h, _ := json.Marshal(map[string]string{"alg": "RS256", "kid": "k1"})
		c, _ := json.Marshal(claims)
		in := b64(h) + "." + b64(c)
		d := sha256.Sum256([]byte(in))
		s, _ := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, d[:])
		return in + "." + b64(s)
	}
	g := NewGoogleVerifier([]string{"client-1"})
	g.CertsURL = srv.URL
	exp := time.Now().Add(time.Hour).Unix()
	good := map[string]any{"iss": "https://accounts.google.com", "aud": "client-1", "sub": "123", "email": "a@b.c", "exp": exp}
	if id, err := g.Verify(t.Context(), sign(good)); err != nil || id.Sub != "123" {
		t.Fatalf("good token: %v %v", id, err)
	}
	for name, mut := range map[string]func(m map[string]any){
		"aud": func(m map[string]any) { m["aud"] = "other" },
		"iss": func(m map[string]any) { m["iss"] = "evil.com" },
		"exp": func(m map[string]any) { m["exp"] = time.Now().Add(-time.Minute).Unix() },
	} {
		m := map[string]any{}
		for k, v := range good {
			m[k] = v
		}
		mut(m)
		if _, err := g.Verify(t.Context(), sign(m)); err == nil {
			t.Errorf("%s: accepted bad token", name)
		}
	}
	tok := sign(good)
	if _, err := g.Verify(t.Context(), tok[:len(tok)-4]+"AAAA"); err == nil {
		t.Error("accepted tampered signature")
	}
}
