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
(needs `GEMINI_API_KEY`; the client is still a stub that makes no network
call), or `stub`. In stub mode a deterministic fake Gemini answers each span
with numbers derived from a hash of the text. Stub mode also enables the
`/test/ai/*` hooks described in API.md, so never use it in production.
`AI_GLOBAL_DAILY_CAP` sets the project-wide daily limit on AI calls
(default 200).

Example: `AI_MODE=stub DATABASE_URL=... go run ./cmd/api`

Weekly cache review: `go run ./cmd/aicache-export > top.csv`
