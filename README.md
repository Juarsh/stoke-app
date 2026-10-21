# Stoke — calorie and workout tracker app, Expo / React Native, v1

Android-first Expo (SDK 57, TypeScript, Expo Router) app for the Hinglish calorie tracker.
Spec: `/workspace/calorie/spec.md` · Design: `/workspace/calorie/design/` (v4 bold redesign) · Backend: `/workspace/calorie-tracker`.

## Identity (name on hold)
All identity comes from `brand.config.js` (env-overridable), read by `app.config.ts` and exposed to the UI via `expo-constants`:
`APP_NAME` (default Stoke), `APP_SLUG` (default `placeholder-fit`, kept for the EAS project), `APP_SCHEME`, `APP_ANDROID_PACKAGE` / `APP_IOS_BUNDLE_ID` (default `app.stokefit`), `APP_INVITE_BASE_URL`. No UI string hardcodes the name.

## Config / flags (env, all optional)
| Var | Effect |
|---|---|
| `EXPO_PUBLIC_API_URL` | Go backend URL. Unset = **mock mode** (everything local, sync queue kept). |
| `EXPO_PUBLIC_FLAG_GOOGLE_SIGNIN=1` + `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID` / `_WEB_CLIENT_ID` | real Google sign-in (expo-auth-session ID token → `Authorization: Bearer`). Otherwise a mock sign-in. |
| `EXPO_PUBLIC_FLAG_HEALTH_CONNECT=1` | read today's steps from Health Connect (dev build only). |
| `EXPO_PUBLIC_FLAG_STEPS=0` | cut steps (protein card goes full width). |
| `EXPO_PUBLIC_FLAG_COMMUNITY=0` | cut the Community tab (nav re-spaces). |

## Scripts
- `npm run sync-dishes` — copies `dishes.json`, `rules.json`, `dev-meals.json` from the backend and regenerates `src/data/golden.json` by running the real Go parser.
- `npm test` — jest: TS parser == Go parser on every dev meal + extra inputs, plus domain/coach/streak/sync tests.
- `npm run typecheck`, `npm run export:android`.
- `npm run parse -- "2 roti dal"` — offline TS parser, prints the backend `/v1/parse` response shape (use_ai=false semantics).
- `npm run parse -- --batch < meals.jsonl` — one JSON line in (`{"text": "..."}` or a bare string) → one response line out.

## Data rules
Saved entries are snapshots: dish id, qty, unit, oil, kcal/protein ranges, carbs/fat and `dish_table_version`. They are never recalculated on sync or table updates; only an explicit user edit changes them.
