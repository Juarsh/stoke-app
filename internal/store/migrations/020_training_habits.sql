-- Stoke M4 (build-plan items 15–16): plans with their routines, finished workouts with their sets, habits with their
-- daily logs. Ids are the phone's own (it creates rows offline). Every row has a server version, 1 on insert and bumped
-- by a trigger on every write (like food_entries.version, 016): an edit sent with an older version is a 409 with the
-- server's row, never a silent overwrite. Bad values are refused by the API with a reason; the CHECKs are the backstop.
CREATE OR REPLACE FUNCTION stoke_bump_version() RETURNS trigger AS $$
BEGIN
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS plans (
  id         TEXT NOT NULL CHECK (id <> '' AND length(id) <= 64),
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 30),
  days       TEXT[] NOT NULL CHECK (array_length(days, 1) = 7),  -- Mon..Sun: a routine id or '' (rest)
  active     BOOLEAN NOT NULL DEFAULT false,
  version    INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, id)
);
CREATE TABLE IF NOT EXISTS routines (
  id         TEXT NOT NULL CHECK (id <> '' AND length(id) <= 64),
  user_id    BIGINT NOT NULL,
  plan_id    TEXT NOT NULL,
  position   INTEGER NOT NULL,
  name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 30),
  exercises  JSONB NOT NULL,  -- [{id, exercise_id, rest_s, target:{sets,repsLow,repsHigh}|null}], checked by the API
  PRIMARY KEY (user_id, plan_id, id),
  FOREIGN KEY (user_id, plan_id) REFERENCES plans(user_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workouts (
  id         TEXT NOT NULL CHECK (id <> '' AND length(id) <= 64),
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 60),
  plan_id    TEXT,
  routine_id TEXT,
  local_date DATE NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at   TIMESTAMPTZ NOT NULL CHECK (ended_at >= started_at),
  version    INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS workouts_day ON workouts(user_id, local_date) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS workout_exercises (
  user_id     BIGINT NOT NULL,
  workout_id  TEXT NOT NULL,
  position    INTEGER NOT NULL,
  ex_id       TEXT NOT NULL,      -- the phone's id of the exercise in this workout
  exercise_id TEXT NOT NULL,      -- library id (wger-73)
  kind        TEXT NOT NULL CHECK (kind IN ('weight','bodyweight','time')),
  rest_s      INTEGER NOT NULL CHECK (rest_s BETWEEN 0 AND 600),
  target      JSONB,              -- {sets, repsLow, repsHigh} or null
  PRIMARY KEY (user_id, workout_id, position),
  FOREIGN KEY (user_id, workout_id) REFERENCES workouts(user_id, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS workout_sets (
  user_id     BIGINT NOT NULL,
  workout_id  TEXT NOT NULL,
  ex_position INTEGER NOT NULL,
  position    INTEGER NOT NULL,
  set_id      TEXT NOT NULL,
  done        BOOLEAN NOT NULL,
  kg          NUMERIC(7,2) CHECK (kg IS NULL OR (kg >= 0 AND kg <= 1000)),
  reps        INTEGER CHECK (reps IS NULL OR reps BETWEEN 1 AND 86400),  -- reps, or seconds for a timed set
  done_at     TIMESTAMPTZ,
  PRIMARY KEY (user_id, workout_id, ex_position, position),
  FOREIGN KEY (user_id, workout_id, ex_position) REFERENCES workout_exercises(user_id, workout_id, position) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS habits (
  id              TEXT NOT NULL CHECK (id <> '' AND length(id) <= 64),
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  short_name      TEXT NOT NULL CHECK (length(short_name) BETWEEN 1 AND 16),
  short_key       TEXT NOT NULL,   -- Q21: lower case, no spaces or hyphens
  short_name_auto BOOLEAN NOT NULL DEFAULT true,
  icon            TEXT,
  kind            TEXT NOT NULL CHECK (kind IN ('done','count','sets')),
  target_value    INTEGER,
  unit            TEXT,
  target_sets     INTEGER,
  target_reps     INTEGER,
  schedule        TEXT NOT NULL CHECK (schedule IN ('daily','weekdays','days')),
  weekdays        SMALLINT NOT NULL CHECK (weekdays BETWEEN 1 AND 127),  -- Mon = bit 0
  starts_on       DATE NOT NULL,
  position        INTEGER NOT NULL,
  archived_at     TIMESTAMPTZ,
  version         INTEGER NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  PRIMARY KEY (user_id, id)
);
-- §8.3: short names are unique among active habits
CREATE UNIQUE INDEX IF NOT EXISTS habits_short_key ON habits(user_id, short_key) WHERE archived_at IS NULL AND deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS habit_logs (
  user_id         BIGINT NOT NULL,
  habit_id        TEXT NOT NULL,
  local_date      DATE NOT NULL,
  id              TEXT NOT NULL,
  value           INTEGER CHECK (value IS NULL OR value >= 0),
  done            BOOLEAN NOT NULL,
  target_snapshot JSONB NOT NULL,
  logged_at       TIMESTAMPTZ NOT NULL,
  version         INTEGER NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  PRIMARY KEY (user_id, habit_id, local_date),   -- §12.5 UNIQUE(habit_id, local_date)
  FOREIGN KEY (user_id, habit_id) REFERENCES habits(user_id, id) ON DELETE CASCADE
);

DROP TRIGGER IF EXISTS plans_version ON plans;
CREATE TRIGGER plans_version BEFORE UPDATE ON plans FOR EACH ROW EXECUTE FUNCTION stoke_bump_version();
DROP TRIGGER IF EXISTS workouts_version ON workouts;
CREATE TRIGGER workouts_version BEFORE UPDATE ON workouts FOR EACH ROW EXECUTE FUNCTION stoke_bump_version();
DROP TRIGGER IF EXISTS habits_version ON habits;
CREATE TRIGGER habits_version BEFORE UPDATE ON habits FOR EACH ROW EXECUTE FUNCTION stoke_bump_version();
DROP TRIGGER IF EXISTS habit_logs_version ON habit_logs;
CREATE TRIGGER habit_logs_version BEFORE UPDATE ON habit_logs FOR EACH ROW EXECUTE FUNCTION stoke_bump_version();
