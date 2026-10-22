package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/akarsh/calorie-tracker/internal/httpx"
	"github.com/akarsh/calorie-tracker/internal/store"
)

// Sessions (M4 item 16): the app signs in once with a Google ID token (POST /v1/auth/google) and gets our own opaque
// session token back, sent as "Authorization: Bearer stk_..." from then on. Google ID tokens live an hour; a session
// lives SessionTTL, so the phone isn't signed out every hour (token refresh is deferred). Only its SHA-256 is stored.

// SessionPrefix marks our session tokens (a Google ID token is a JWT and never starts with it).
const SessionPrefix = "stk_"

// SessionTTL: how long a session lasts. There is no refresh yet: when it ends the app signs out and keeps its data.
const SessionTTL = 90 * 24 * time.Hour

// ErrNoSession: unknown, revoked or expired.
var ErrNoSession = errors.New("no session")

type Sessions interface {
	Create(ctx context.Context, hash []byte, uid int64, expires time.Time) error
	User(ctx context.Context, hash []byte, now time.Time) (int64, error) // ErrNoSession when not live
	Delete(ctx context.Context, hash []byte) error
}

// PGSessions keeps sessions in Postgres through the store.
type PGSessions struct{ DB *pgxpool.Pool }

func (s PGSessions) pg() *store.PG { return &store.PG{DB: s.DB} }
func (s PGSessions) Create(ctx context.Context, hash []byte, uid int64, expires time.Time) error {
	return s.pg().CreateSession(ctx, hash, uid, expires)
}
func (s PGSessions) User(ctx context.Context, hash []byte, now time.Time) (int64, error) {
	uid, err := s.pg().SessionUser(ctx, hash, now)
	if errors.Is(err, store.ErrNotFound) {
		return 0, ErrNoSession
	}
	return uid, err
}
func (s PGSessions) Delete(ctx context.Context, hash []byte) error {
	return s.pg().DeleteSession(ctx, hash)
}

func tokenHash(tok string) []byte { h := sha256.Sum256([]byte(tok)); return h[:] }

// NewSessionToken: "stk_" + 32 random bytes, base64url.
func NewSessionToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return SessionPrefix + base64.RawURLEncoding.EncodeToString(b), nil
}

func reason(w http.ResponseWriter, status int, code, msg string) {
	httpx.JSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": msg}})
}

// SignIn serves the sign-in routes:
//
//	POST /v1/auth/google  {"id_token":"<Google ID token>"} -> 200 {"user":{"id","email","name"},"session_token","expires_at"}
//	POST /v1/auth/signout (Bearer session) -> 204, the session is revoked (an unknown one counts as done)
//
// A refused token is 401 {"error":{"code","message"}}: google_not_configured (GOOGLE_CLIENT_IDS has no real client id
// yet) or invalid_token (with why: expired, wrong audience, bad signature, ...).
type SignIn struct {
	Verifier Verifier
	Users    Users
	Sessions Sessions
	Now      func() time.Time
}

func (s *SignIn) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *SignIn) Routes(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/auth/google", s.google)
	mux.HandleFunc("POST /v1/auth/signout", s.signout)
}

func (s *SignIn) google(w http.ResponseWriter, r *http.Request) {
	var in struct {
		IDToken string `json:"id_token"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if strings.TrimSpace(in.IDToken) == "" {
		reason(w, http.StatusBadRequest, "id_token_required", "Send the Google ID token as id_token.")
		return
	}
	if c, ok := s.Verifier.(interface{ Configured() bool }); ok && !c.Configured() {
		reason(w, http.StatusUnauthorized, "google_not_configured", "Google sign-in isn't set up on this server yet (GOOGLE_CLIENT_IDS has no OAuth client id).")
		return
	}
	id, err := s.Verifier.Verify(r.Context(), strings.TrimSpace(in.IDToken))
	if err != nil {
		reason(w, http.StatusUnauthorized, "invalid_token", "Google sign-in was refused: "+err.Error()+".")
		return
	}
	uid, err := s.Users.Upsert(r.Context(), id)
	if err != nil {
		reason(w, http.StatusInternalServerError, "user_lookup_failed", "Couldn't find or create your account. Try again.")
		return
	}
	tok, err := NewSessionToken()
	if err != nil {
		reason(w, http.StatusInternalServerError, "session_failed", "Couldn't start a session. Try again.")
		return
	}
	exp := s.now().Add(SessionTTL).UTC().Truncate(time.Second)
	if err := s.Sessions.Create(r.Context(), tokenHash(tok), uid, exp); err != nil {
		reason(w, http.StatusInternalServerError, "session_failed", "Couldn't start a session. Try again.")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"user":          map[string]any{"id": uid, "email": id.Email, "name": id.Name},
		"session_token": tok, "expires_at": exp,
	})
}

func (s *SignIn) signout(w http.ResponseWriter, r *http.Request) {
	tok, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if tok = strings.TrimSpace(tok); strings.HasPrefix(tok, SessionPrefix) {
		if err := s.Sessions.Delete(r.Context(), tokenHash(tok)); err != nil {
			reason(w, http.StatusInternalServerError, "signout_failed", "Couldn't sign out on the server. Try again.")
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}
