// Package auth verifies Google ID tokens (Google sign-in only in v1) behind
// middleware and maps them to users. Tests swap in a fake Verifier.
package auth

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/akarsh/calorie-tracker/internal/httpx"
	"github.com/akarsh/calorie-tracker/internal/store"
)

// Identity is all we keep from a verified token.
type Identity struct {
	Sub   string
	Email string
	Name  string
}

type Verifier interface {
	Verify(ctx context.Context, token string) (Identity, error)
}

var ErrInvalid = errors.New("invalid token")

// GoogleVerifier checks the RS256 signature against Google's JWKS, plus
// issuer, audience (our OAuth client IDs) and expiry.
type GoogleVerifier struct {
	Audiences []string
	CertsURL  string
	Client    *http.Client
	Now       func() time.Time

	mu      sync.Mutex
	keys    map[string]*rsa.PublicKey
	fetched time.Time
}

func NewGoogleVerifier(aud []string) *GoogleVerifier {
	return &GoogleVerifier{Audiences: aud, CertsURL: "https://www.googleapis.com/oauth2/v3/certs",
		Client: &http.Client{Timeout: 5 * time.Second}, Now: time.Now}
}

func (g *GoogleVerifier) key(ctx context.Context, kid string) (*rsa.PublicKey, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if k, ok := g.keys[kid]; ok && time.Since(g.fetched) < 6*time.Hour {
		return k, nil
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", g.CertsURL, nil)
	res, err := g.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var jwks struct {
		Keys []struct{ Kid, N, E string } `json:"keys"`
	}
	if err := json.NewDecoder(res.Body).Decode(&jwks); err != nil {
		return nil, err
	}
	g.keys = map[string]*rsa.PublicKey{}
	for _, k := range jwks.Keys {
		n, err1 := base64.RawURLEncoding.DecodeString(k.N)
		e, err2 := base64.RawURLEncoding.DecodeString(k.E)
		if err1 != nil || err2 != nil {
			continue
		}
		g.keys[k.Kid] = &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}
	}
	g.fetched = time.Now()
	if k, ok := g.keys[kid]; ok {
		return k, nil
	}
	return nil, ErrInvalid
}

func (g *GoogleVerifier) Verify(ctx context.Context, tok string) (Identity, error) {
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		return Identity{}, fmt.Errorf("%w: not a JWT", ErrInvalid)
	}
	var hdr struct{ Alg, Kid string }
	var cl struct {
		Iss, Sub, Email, Name, Aud string
		Exp                        int64
	}
	hb, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || json.Unmarshal(hb, &hdr) != nil || hdr.Alg != "RS256" {
		return Identity{}, fmt.Errorf("%w: bad header", ErrInvalid)
	}
	cb, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || json.Unmarshal(cb, &cl) != nil {
		return Identity{}, fmt.Errorf("%w: bad claims", ErrInvalid)
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return Identity{}, fmt.Errorf("%w: bad signature encoding", ErrInvalid)
	}
	k, err := g.key(ctx, hdr.Kid)
	if err != nil {
		return Identity{}, fmt.Errorf("%w: unknown signing key (%v)", ErrInvalid, err)
	}
	h := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if rsa.VerifyPKCS1v15(k, crypto.SHA256, h[:], sig) != nil {
		return Identity{}, fmt.Errorf("%w: bad signature", ErrInvalid)
	}
	if cl.Iss != "accounts.google.com" && cl.Iss != "https://accounts.google.com" {
		return Identity{}, fmt.Errorf("%w: wrong issuer", ErrInvalid)
	}
	okAud := false
	for _, a := range g.Audiences {
		okAud = okAud || (a != "" && a == cl.Aud)
	}
	switch {
	case !okAud:
		// Android: Google Sign-In's ID token has aud = the WEB client id (azp = the Android one), so the web id must be
		// in GOOGLE_CLIENT_IDS
		return Identity{}, fmt.Errorf("%w: audience is not one of this server's client ids", ErrInvalid)
	case cl.Sub == "":
		return Identity{}, fmt.Errorf("%w: no subject", ErrInvalid)
	case g.Now().Unix() >= cl.Exp:
		return Identity{}, fmt.Errorf("%w: expired", ErrInvalid)
	}
	return Identity{Sub: cl.Sub, Email: cl.Email, Name: cl.Name}, nil
}

// Configured: at least one audience is a real OAuth client id (GOOGLE_CLIENT_IDS=pending, a placeholder, is not), so the
// sign-in endpoint can say "not set up" rather than "invalid token".
func (g *GoogleVerifier) Configured() bool {
	for _, a := range g.Audiences {
		if strings.HasSuffix(a, ".apps.googleusercontent.com") {
			return true
		}
	}
	return false
}

// DevVerifier accepts "dev:<name>" tokens. Local runs only (AUTH_MODE=dev).
type DevVerifier struct{}

func (DevVerifier) Verify(_ context.Context, tok string) (Identity, error) {
	if s, ok := strings.CutPrefix(tok, "dev:"); ok && s != "" {
		return Identity{Sub: "dev:" + s, Email: s + "@dev.local"}, nil
	}
	return Identity{}, ErrInvalid
}

type Users interface {
	Upsert(ctx context.Context, id Identity) (int64, error)
}

// PGUsers maps a verified identity to our own user id through the store (user_identities: provider + subject).
type PGUsers struct{ DB *pgxpool.Pool }

func (u PGUsers) Upsert(ctx context.Context, id Identity) (int64, error) {
	return (&store.PG{DB: u.DB}).Resolve(ctx, id.Provider(), id.Sub, id.Email, id.Name)
}

// Provider: "dev" for a dev token's identity, else "google".
func (id Identity) Provider() string {
	if strings.HasPrefix(id.Sub, "dev:") {
		return "dev"
	}
	return "google"
}

// FromConfig picks the token verifier (AUTH_MODE): "google" (default) checks Google ID tokens against clientIDs
// (GOOGLE_CLIENT_IDS, comma separated); "dev" accepts "dev:<name>" test tokens and is refused when appEnv is
// production, so a misconfigured deploy fails at start instead of letting anyone in.
func FromConfig(mode, appEnv, clientIDs string) (Verifier, error) {
	switch mode {
	case "dev":
		switch strings.ToLower(strings.TrimSpace(appEnv)) {
		case "production", "prod":
			return nil, fmt.Errorf("AUTH_MODE=dev is refused when APP_ENV=%s", appEnv)
		}
		return DevVerifier{}, nil
	case "", "google":
		var ids []string
		for _, s := range strings.Split(clientIDs, ",") {
			if s = strings.TrimSpace(s); s != "" {
				ids = append(ids, s)
			}
		}
		if len(ids) == 0 {
			return nil, errors.New("GOOGLE_CLIENT_IDS is required when AUTH_MODE=google")
		}
		return NewGoogleVerifier(ids), nil
	default:
		return nil, fmt.Errorf("AUTH_MODE must be google or dev (got %q)", mode)
	}
}

// Middleware requires "Authorization: Bearer <token>": a Google ID token, or no session store.
func Middleware(v Verifier, users Users) func(http.Handler) http.Handler {
	return WithSessions(v, users, nil)
}

// WithSessions requires "Authorization: Bearer <token>": our session token (stk_..., from POST /v1/auth/google) when
// sessions is set, else a Google ID token verified on every request (as before sessions).
func WithSessions(v Verifier, users Users, sessions Sessions) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			tok, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
			tok = strings.TrimSpace(tok)
			if !ok || tok == "" {
				httpx.Error(w, http.StatusUnauthorized, "missing bearer token")
				return
			}
			if sessions != nil && strings.HasPrefix(tok, SessionPrefix) {
				uid, err := sessions.User(r.Context(), tokenHash(tok), time.Now())
				switch {
				case errors.Is(err, ErrNoSession):
					httpx.Error(w, http.StatusUnauthorized, "session expired or signed out")
					return
				case err != nil:
					httpx.Error(w, http.StatusInternalServerError, "session lookup failed")
					return
				}
				next.ServeHTTP(w, r.WithContext(httpx.WithUser(r.Context(), uid)))
				return
			}
			id, err := v.Verify(r.Context(), tok)
			if err != nil {
				httpx.Error(w, http.StatusUnauthorized, "invalid token")
				return
			}
			uid, err := users.Upsert(r.Context(), id)
			if err != nil {
				httpx.Error(w, http.StatusInternalServerError, "user lookup failed")
				return
			}
			next.ServeHTTP(w, r.WithContext(httpx.WithUser(r.Context(), uid)))
		})
	}
}
