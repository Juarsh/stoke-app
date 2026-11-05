-- Per-user daily Ask Coach question cap (M1). Counted in IST calendar dates
-- (the same day boundary as the rest of the API). Deleting a user drops their
-- rows. Append-only like every migration.
CREATE TABLE IF NOT EXISTS coach_daily_asks (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day     DATE NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (user_id, day)
);
