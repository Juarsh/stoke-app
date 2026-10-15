# Khaana Count backend (working name)

Go 1.24 + Postgres 17. V1 = food, coach, steps, streaks. Spec: /workspace/calorie/spec.md. API: API.md.

```
internal/dishes    dishes.json — the ONE canonical dish table (also shipped in the app)
internal/parser    Hinglish parser; vocabulary in rules.json (data-driven, for the TS port)
internal/food      /v1/parse, AI fallback interface + daily cap, food_entries CRUD + sync
internal/activity  Health Connect steps ingest (workouts in V2)
internal/goals     profile, diet, targets with macros
internal/summary   daily_summaries (Contributor plug-in per domain) + streaks with auto freeze
internal/coach     rule-based suggestions; Advisor interface = LLM hook
internal/body, internal/social   V2 / V3 placeholders
internal/db        migrations (001 = V1; migrations_v2 only with MIGRATE_V2=1)
internal/auth      Google ID token verification middleware
```

Run: `AUTH_MODE=dev go run ./cmd/api` (DATABASE_URL defaults to postgres://calorie:calorie@localhost:5432/calorie).
Prod: `GOOGLE_CLIENT_IDS=<android client id>,... go run ./cmd/api`.
Test: `go test ./...` (API tests use the calorie_test DB and reset its schema).

Dish table: values are our own estimates or generic public data (USDA FDC, Open Food Facts labels). No IFCT data.
`internal/parser/testdata/dev-meals.json` holds Coder's DEV samples only; the accuracy set is Tester's (/workspace/calorie-tests).

## AI modes

`AI_MODE` can be `off` (default, no AI, generic confirm cards), `gemini`
(real REST generateContent call), or `stub`. In stub mode a deterministic fake Gemini answers each span
with numbers derived from a hash of the text. Stub mode also enables the
`/test/ai/*` hooks described in API.md, so never use it in production.
Stub mode only starts when `APP_ENV` is `dev` or `test`; the server refuses
to start otherwise. `AI_MODE=gemini` requires `GEMINI_API_KEY`, and
`GEMINI_MODEL` is optional. `AI_PER_MINUTE` sets the AI queue drain rate,
AI calls per minute (default 8). Tests never call the real Gemini API.
`AI_DAILY_CAP` sets the project-wide daily limit on AI meals (default 20, the
Gemini free tier), `AI_USER_DAILY_CAP` the per-user limit (default 3),
`AI_QUOTA_RESET_TZ` when they reset (default America/Los_Angeles midnight,
Google's reset), `GEMINI_RPM` the global spacing of Gemini attempts
(default 10), `AI_REQUEUE_MAX_MINUTES` how long a busy Gemini job keeps
being requeued before it ends as `gave_up` (default 30), and
`GEMINI_THINKING_BUDGET` the per-model `thinkingConfig` (`omit`, a number, or
empty for the model default: budget 0 on `gemini-flash-latest`, omitted on
Flash-Lite which 400s on `thinkingBudget`). Each requeue attempt that reaches
Gemini (not a 429) counts against the daily caps. Google's daily-quota
exhausted mark is stored in the DB so it survives a restart. See API.md
"AI quota, retries and fallback_reason".

Example: `APP_ENV=dev AI_MODE=stub DATABASE_URL=... go run ./cmd/api`

Weekly cache review: `go run ./cmd/aicache-export > top.csv`

Tests: `go test ./...`. The integration tests create a throwaway database
named `ct_run_<random>` and drop it when they finish. `TEST_PG_ADMIN_URL`
must point at a role that has CREATEDB.

## Database setup

Run `scripts/setup-db.sh` before every test run. It is safe to rerun: it
installs/starts Postgres if missing, creates the `calorie` role (CREATEDB) and
the `calorie` and `calorie_test` databases, and runs the migrations on both.
