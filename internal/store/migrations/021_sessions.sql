-- Our own sign-in sessions (M4 item 16): the app trades a Google ID token for a long-lived opaque session token once
-- (POST /v1/auth/google) and sends that from then on, so a one-hour Google token never signs the user out. Only the
-- token's SHA-256 is stored. Deleting a user (DELETE /v1/me) drops their sessions with them. Append-only like every
-- migration.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   BYTEA PRIMARY KEY CHECK (length(token_hash) = 32),
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
