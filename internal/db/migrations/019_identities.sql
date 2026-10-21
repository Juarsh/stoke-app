-- Our own user ids, mapped to sign-in identities (Google today; the dev token for local / CI). users.google_sub stays as
-- it was (older code and data); new sign-ins resolve through user_identities first. Append-only like every migration.
CREATE TABLE IF NOT EXISTS user_identities (
  provider   TEXT NOT NULL CHECK (provider IN ('google','dev')),
  subject    TEXT NOT NULL CHECK (subject <> ''),
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email      TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS user_identities_user ON user_identities(user_id);
INSERT INTO user_identities(provider, subject, user_id, email)
  SELECT CASE WHEN google_sub LIKE 'dev:%' THEN 'dev' ELSE 'google' END, google_sub, id, email FROM users
  ON CONFLICT DO NOTHING;
