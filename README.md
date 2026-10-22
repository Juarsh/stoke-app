# Stoke backend

Stoke is a fitness app with three parts: **Food** (log meals in plain Hinglish, calories and macros),
**Train** (plans, routines and workout logging) and **Habits** (daily and weekly habits with streaks).
This repo is the backend: a Go 1.24 JSON API on plain Postgres (no vendor-specific extensions, so the
database can move to any Postgres host), shipped as one Docker image. API reference: [API.md](API.md).

The app (Expo / React Native) lives on the `app` branch. The phone works fully offline; this server adds
sign-in, sync and AI food estimates.

```
internal/dishes    dishes.json — the ONE canonical dish table (also shipped in the app)
internal/parser    Hinglish parser; vocabulary in rules.json (data-driven, for the TS port)
internal/food      /v1/parse, AI fallback interface + daily cap, food_entries CRUD + sync
internal/activity  Health Connect steps ingest (workouts in V2)
internal/goals     profile, diet, targets with macros
internal/summary   daily_summaries (Contributor plug-in per domain) + streaks with auto freeze
internal/coach     rule-based suggestions; Advisor interface = LLM hook
internal/body, internal/social   V2 / V3 placeholders
internal/db        Open/Migrate entry points (migration files: internal/store/migrations, migrations_v2 only with MIGRATE_V2=1)
internal/auth      Google ID token verification middleware
```

Run: `AUTH_MODE=dev go run ./cmd/api` (DATABASE_URL defaults to postgres://calorie:calorie@localhost:5432/calorie).
Prod: `GOOGLE_CLIENT_IDS=<android client id>,... go run ./cmd/api`.
Test: `go test ./...` (API tests use the calorie_test DB and reset its schema).

Dish table: values are our own estimates or generic public data (USDA FDC, Open Food Facts labels). No IFCT data.
`internal/parser/testdata/dev-meals.json` holds Coder's DEV samples only; the accuracy set is kept separately.

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
being requeued before it ends as `gave_up` (default 30), `AI_MAX_ATTEMPTS`
the Gemini attempts per meal before it ends as `gave_up` (default 3), and
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

## Stoke sync (M4): plans, workouts, habits

Endpoints (all need `Authorization: Bearer <token>`; rules as for food entries: the answer is the stored row and is the
truth, an edit sent with an older `version` is a `409 version_conflict` with the server's `row`, a bad value is a `400`
`{"error":{"code":"invalid","message":"<reason>"}}`, never clamped):

| | |
|---|---|
| `GET /v1/plans`, `GET/PUT/DELETE /v1/plans/{id}` | a plan with its routines (`days` Mon..Sun: routine id or `""`) |
| `GET /v1/workouts?from&to`, `GET/PUT/DELETE /v1/workouts/{id}` | a finished workout with its sets, plus the server's `summary` |
| `GET /v1/habits`, `GET/PUT/DELETE /v1/habits/{id}` | a habit (archive = `archived_at`) |
| `GET /v1/habit-logs?from&to`, `PUT/DELETE /v1/habits/{id}/logs/{date}` | one log per habit and day |

PUT bodies carry `version` (omit it on the first save); DELETE takes `?version=`. Ids are made on the phone. A deleted
row answers `404 {"error":{"code":"gone"}}`. Tables: migrations `019_identities.sql` (our user ids <-> sign-in
identities) and `020_training_habits.sql`. All SQL for them is in `internal/store` (repository interfaces + plain
Postgres); handlers are in `internal/stoke`.

Auth (`AUTH_MODE`): `google` (default) verifies Google ID tokens against `GOOGLE_CLIENT_IDS`; `dev` accepts
`Bearer dev:<name>` for local runs and CI and **refuses to start when `APP_ENV=production` (or `prod`)**.

Run locally: `DATABASE_URL=postgres://calorie:calorie@localhost:5432/calorie_stoke AUTH_MODE=dev APP_ENV=dev PORT=8095 go run ./cmd/api`.
Tests: `go test ./...` (the Stoke packages use throwaway schemas in `calorie_stoke_test`, `TEST_STOKE_DB_URL` to change it).

Image: `docker build -t stoke-api .` (multi-stage, static `CGO_ENABLED=0` binary on distroless; all config from env).

Move data (plain Postgres, any host):
- `DATABASE_URL=... go run ./cmd/stoke-export export [-user ID] -out dump.json` and `... import -in dump.json`
  (JSON, every table or one user's rows; import migrates first, runs in one transaction, refuses rows that already exist).
- `FROM_URL=... TO_URL=... scripts/db-move.sh` (pg_dump / pg_restore of the whole database, schema included).

## Configuration (environment variables)

Names only; never commit values. Set secrets in the host's dashboard.

| Variable | Needed | Notes |
|---|---|---|
| `DATABASE_URL` | yes (secret) | Postgres connection string, e.g. Neon's pooled string with `?sslmode=require` |
| `APP_ENV` | yes | `prod` in production; `dev` / `test` locally |
| `AUTH_MODE` | yes | `google` (default) or `dev` (refused when `APP_ENV=prod`) |
| `GOOGLE_CLIENT_IDS` | with `AUTH_MODE=google` (secret) | comma-separated OAuth client ids (Android, Web, iOS) |
| `AI_MODE` | no | `off` (default), `gemini`, or `stub` (dev/test only) |
| `GEMINI_API_KEY` | with `AI_MODE=gemini` (secret) | Google AI Studio key |
| `GEMINI_MODEL`, `GEMINI_RPM`, `GEMINI_THINKING_BUDGET` | no | see "AI modes" |
| `AI_DAILY_CAP`, `AI_USER_DAILY_CAP`, `AI_GLOBAL_DAILY_CAP`, `AI_PER_MINUTE`, `AI_QUOTA_RESET_TZ`, `AI_REQUEUE_MAX_MINUTES`, `AI_MAX_ATTEMPTS` | no | AI limits, see "AI modes" |
| `ADMIN_TOKEN` | no (secret) | enables `/admin/*` (API.md); at least 24 characters, unset = no admin routes |
| `PORT` | no | set by the host (Render sets it); defaults to 8080 in the image |

## Docker

`docker build -t stoke-api . && docker run -p 8080:8080 -e DATABASE_URL=... -e APP_ENV=prod ... stoke-api`

Multi-stage build: a static `CGO_ENABLED=0` binary on distroless. All config comes from the environment and the
server runs the migrations on start.

## Deploy on Render

`render.yaml` describes the service as a Blueprint; to create it by hand:

1. Render dashboard → **New** → **Web Service** → connect GitHub and pick `Juarsh/stoke-app`.
2. Name `stoke-api`, Language **Docker** (uses the `Dockerfile`), Branch `main`, Region **Singapore**,
   Root Directory empty.
3. Instance type **Free**.
4. Environment variables: `APP_ENV=prod`, `AUTH_MODE=google`, `AI_MODE=gemini`, plus the secrets `DATABASE_URL`,
   `GEMINI_API_KEY`, `GOOGLE_CLIENT_IDS` (and optionally `ADMIN_TOKEN`). Don't set `PORT`.
5. Advanced → Health Check Path `/healthz`.
6. **Deploy Web Service**. The free instance sleeps when idle, so the first request after a pause is slow.

### Accounts to plug in

Nothing here needs them to build or test. To go live:

1. **Neon**: create a project + database, copy its pooled connection string (with `?sslmode=require`) as `DATABASE_URL`.
   The server runs the migrations on start. To bring local data across: `scripts/db-move.sh` or `stoke-export`.
2. **Render**: service `stoke-api` (see "Deploy on Render" above, or any host running the Dockerfile).
3. **Google Cloud** (OAuth consent screen + credentials):
   - an **Android** OAuth client: package `app.stokefit`, SHA-1 `5E:8F:16:06:2E:A3:CD:2C:4A:0D:54:78:76:BA:A6:F3:8C:AB:F6:25`
     (the current debug/upload key); add the **release key's SHA-1 later** (Play signing) as a second fingerprint;
   - a **Web** client (expo-auth-session uses it; also the audience on some Android flows);
   - `GOOGLE_CLIENT_IDS` on the server = every one of those client ids, comma separated.
4. **App build env** (EAS / `.env`): `EXPO_PUBLIC_API_URL=https://<render host>`, `EXPO_PUBLIC_FLAG_GOOGLE_SIGNIN=1`,
   `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`, `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` (and `..._IOS_CLIENT_ID` later). Without
   `EXPO_PUBLIC_API_URL` the app stays fully on the phone, as today.
