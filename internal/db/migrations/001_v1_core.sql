-- V1 schema, following /workspace/calorie/spec.md "Data model".
-- Times in UTC; days are local_date in the user's tz (default Asia/Kolkata).
-- Every entry table has user_id, local_date, source, deleted_at (soft delete) and updated_at.
CREATE TABLE IF NOT EXISTS users (
  id          BIGSERIAL PRIMARY KEY,
  google_sub  TEXT NOT NULL UNIQUE,
  email       TEXT NOT NULL DEFAULT '',
  name        TEXT NOT NULL DEFAULT '',
  tz          TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  diet        TEXT NOT NULL DEFAULT 'nonveg' CHECK (diet IN ('veg','egg','nonveg')),
  steps_in_budget BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id        BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  sex            TEXT NOT NULL CHECK (sex IN ('male','female')),
  birth_year     INT  NOT NULL CHECK (birth_year BETWEEN 1920 AND 2015),
  height_cm      NUMERIC(5,1) NOT NULL CHECK (height_cm BETWEEN 100 AND 250),
  weight_kg      NUMERIC(5,1) NOT NULL CHECK (weight_kg BETWEEN 25 AND 300),
  activity_level TEXT NOT NULL CHECK (activity_level IN ('sedentary','light','moderate','active','very_active')),
  goal           TEXT NOT NULL CHECK (goal IN ('fat_loss','maintain','muscle_gain')),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Target history: past days keep the target that was active then.
CREATE TABLE IF NOT EXISTS targets (
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  effective_from DATE NOT NULL,
  kcal           INT NOT NULL CHECK (kcal BETWEEN 800 AND 6000),
  protein_g      INT NOT NULL CHECK (protein_g BETWEEN 0 AND 400),
  carbs_g        INT NOT NULL,
  fat_g          INT NOT NULL,
  water_ml       INT NOT NULL DEFAULT 2500,
  steps          INT NOT NULL DEFAULT 8000,
  custom         BOOLEAN NOT NULL DEFAULT false,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, effective_from)
);

CREATE TABLE IF NOT EXISTS food_entries (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_date    DATE NOT NULL,
  slot          TEXT NOT NULL CHECK (slot IN ('breakfast','lunch','snacks','dinner')),
  raw_text      TEXT NOT NULL DEFAULT '',
  dish_id       TEXT,
  custom_name   TEXT NOT NULL DEFAULT '',
  qty           NUMERIC(8,2) NOT NULL CHECK (qty > 0),
  unit          TEXT NOT NULL,
  oil_level     TEXT NOT NULL DEFAULT '' CHECK (oil_level IN ('','less','normal','extra')),
  kcal_best     NUMERIC(8,1) NOT NULL CHECK (kcal_best >= 0),
  kcal_low      NUMERIC(8,1) NOT NULL,
  kcal_high     NUMERIC(8,1) NOT NULL,
  protein_best  NUMERIC(7,1) NOT NULL CHECK (protein_best >= 0),
  protein_low   NUMERIC(7,1) NOT NULL,
  protein_high  NUMERIC(7,1) NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('table','ai','barcode','photo','manual','custom')),
  confirmed     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  CHECK (dish_id IS NOT NULL OR custom_name <> '')
);
CREATE INDEX IF NOT EXISTS food_entries_user_day ON food_entries(user_id, local_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS food_entries_user_updated ON food_entries(user_id, updated_at);

-- kind=steps in v1; kind=workout columns are ready for v2.
CREATE TABLE IF NOT EXISTS activity_entries (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_date    DATE NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('steps','workout')),
  source        TEXT NOT NULL CHECK (source IN ('health_connect','manual')),
  steps         INT CHECK (steps BETWEEN 0 AND 200000),
  workout_type  TEXT,
  duration_min  INT,
  kcal_burned   NUMERIC(7,1),
  raw_text      TEXT NOT NULL DEFAULT '',
  external_id   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS activity_entries_ext ON activity_entries(user_id, source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS activity_entries_user_day ON activity_entries(user_id, local_date) WHERE deleted_at IS NULL;

-- Shared daily summary; rebuilt whenever an entry changes. Later pillars add columns.
CREATE TABLE IF NOT EXISTS daily_summaries (
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_date  DATE NOT NULL,
  kcal_in     NUMERIC(8,1) NOT NULL DEFAULT 0,
  protein_in  NUMERIC(7,1) NOT NULL DEFAULT 0,
  kcal_out    NUMERIC(8,1) NOT NULL DEFAULT 0,
  steps       INT NOT NULL DEFAULT 0,
  water_ml    INT NOT NULL DEFAULT 0,
  logged      BOOLEAN NOT NULL DEFAULT false,
  streak_day  INT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, local_date)
);

CREATE TABLE IF NOT EXISTS streaks (
  user_id          BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  current          INT NOT NULL DEFAULT 0,
  best             INT NOT NULL DEFAULT 0,
  freezes_left     INT NOT NULL DEFAULT 1,
  freeze_week      DATE,           -- Monday (IST) of the week the freeze counter belongs to
  last_logged_date DATE,
  freeze_used_on   DATE,           -- last day a freeze bridged; app shows "Your freeze saved your streak"
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS challenges (
  id          BIGSERIAL PRIMARY KEY,
  owner_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  start_date  DATE NOT NULL,
  days        INT NOT NULL DEFAULT 21,
  invite_code TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS challenge_members (
  challenge_id BIGINT NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (challenge_id, user_id)
);

CREATE TABLE IF NOT EXISTS events (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  props      JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_usage (
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  local_date DATE NOT NULL,
  calls      INT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, local_date)
);
