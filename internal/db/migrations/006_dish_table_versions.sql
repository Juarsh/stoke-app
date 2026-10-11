-- Every published dish table, kept forever, so entries made offline against
-- an older table can still be validated with that version's numbers.
CREATE TABLE IF NOT EXISTS dish_table_versions (
  version      INT PRIMARY KEY,
  sha256       TEXT NOT NULL,
  snapshot     JSONB NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
