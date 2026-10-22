package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// ---- sessions (migration 021) ----------------------------------------------------------------------------------

// CreateSession stores a new session (the token's SHA-256 only) for uid until expires.
func (s *PG) CreateSession(ctx context.Context, hash []byte, uid int64, expires time.Time) error {
	_, err := s.DB.Exec(ctx, `INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ($1,$2,$3)`, hash, uid, expires)
	return err
}

// SessionUser: the user of a live session (ErrNotFound when it is unknown, revoked or expired). Marks it used at most
// once an hour, so a busy phone doesn't write on every request.
func (s *PG) SessionUser(ctx context.Context, hash []byte, now time.Time) (int64, error) {
	var uid int64
	var used time.Time
	err := s.DB.QueryRow(ctx, `SELECT user_id,last_used_at FROM sessions WHERE token_hash=$1 AND expires_at>$2`, hash, now).Scan(&uid, &used)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, err
	}
	if now.Sub(used) > time.Hour {
		_, _ = s.DB.Exec(ctx, `UPDATE sessions SET last_used_at=$2 WHERE token_hash=$1`, hash, now)
	}
	return uid, nil
}

// DeleteSession revokes one session (sign out); an unknown one is already gone.
func (s *PG) DeleteSession(ctx context.Context, hash []byte) error {
	_, err := s.DB.Exec(ctx, `DELETE FROM sessions WHERE token_hash=$1`, hash)
	return err
}
