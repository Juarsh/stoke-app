# API (v1)

JSON only, no cookies. Every `/v1` route except `GET /v1/dishes` needs
`Authorization: Bearer <Google ID token>` (the app gets it from Google sign-in;
the server checks signature, issuer, audience = our OAuth client IDs, expiry).
Local dev: run with `AUTH_MODE=dev` and send `Bearer dev:<any-name>`.
Errors: `{"error": "..."}` with 400 / 401 / 404 / 409 / 500.
Dates are `YYYY-MM-DD` local dates (IST); omitted = today in IST.

## POST /v1/parse

Request:
```json
{ "text": "2 roti dal sabzi thoda ghee", "use_ai": true }
```
`text` 1-500 chars. `use_ai` (default true) lets unmatched text go to the AI
fallback (Gemini; not wired yet, so it reports `not_configured`).

Response 200:
```json
{
  "items": [
    {
      "dish_id": "roti",            // stable snake_case id from dishes.json ("" for AI items)
      "name": "roti",
      "matched_text": "roti",
      "quantity": 2,
      "unit": "count",              // count | piece | katori | spoon | plate | glass | gram
      "grams": 80,
      "oil_level": "",              // less | normal | extra, "" if the dish has no cooking oil
      "kcal":      { "low": 165, "best": 220, "high": 275 },
      "protein_g": { "low": 5.2, "best": 7,   "high": 8.8 },
      "source": "table",            // table | did_you_mean | generic | ai_estimate
      "needs_confirmation": false,  // only confident table matches are false
      "data_source": "estimate",    // where the numbers come from: estimate | usda_fdc | open_food_facts | ai
      "source_note": "Our estimate: home-style recipe ...",
      "carbs_g": 32, "fat_g": 4.9,  // estimates (see dish macro_note)
      "fuzzy": false,               // matched via typo tolerance
      "from_combo": "",             // e.g. "chole_bhature" when a combo with a portion was split into parts
      "alternatives": [],           // when the sanity check fires (over 1000 kcal or >3x the standard portion): [{quantity, unit, kcal, label}]
      "ai_estimate": false          // true = show "AI estimate" badge, user must confirm
    }
  ],
  "unmatched": ["quinoa"],          // text the table didn't recognise
  "total": {                        // best guess = sum of item "best"
    "kcal": 575, "kcal_low": 450, "kcal_high": 700,
    "protein_g": 19, "protein_low": 14.6, "protein_high": 23.4,
    "carbs_g": 80, "fat_g": 18      // estimates
  },
  "needs_confirmation": false,      // true if any item needs confirmation
  "used_ai": false,
  "fallback": "not_configured",     // none | used | not_configured | cap_reached | error
  "custom_items": [ { "custom_name": "quinoa", "needs_input": true } ],
  "message": "AI estimates are back tomorrow. Add it yourself for now.",  // only when cap_reached
  "slot": "lunch"                   // suggested slot from the time of the request
}
```
### Item sources (hard rule)
| source | meaning | needs_confirmation |
|---|---|---|
| `table` | confident match in our dish table | false, unless the sanity check fires (over 1000 kcal or more than 3x the standard portion) |
| `did_you_mean` | typo-tolerant match ("chapatii" -> roti) | true |
| `generic` | unknown dish with a protein word -> wide-range generic item (e.g. "paneer lababdar" -> generic paneer dish), or a placeholder for unknown text | true |
| `ai_estimate` | Gemini fallback result | true |

Unknown text is never counted as 0 kcal. Every unknown food-like span goes to
the AI fallback (20 calls per user per IST day, `ai_usage` table). If AI is off,
capped or failing, the span becomes a `generic` placeholder item (100-500 kcal,
best 250, needs confirmation) and is also listed in `custom_items` so the user
can type their own numbers.

## Saving rules (POST /v1/entries)
- Every item must have `source` (table, did_you_mean, generic, ai_estimate, or custom for numbers the user typed). Missing or unknown source: 400.
- Any item that needs confirmation must carry `"confirmed": true`, otherwise 400. That covers did_you_mean, generic, ai_estimate, generic table rows, and table items the sanity check flags (the server re-checks; a client cannot skip it by sending source=table).
- 0 kcal is rejected unless the item is `custom` (typed by the user). The only other exception is a table row whose own value is 0 (water).
- Dish items are recomputed from the table on the server; the client's numbers are ignored.
- Text-only saves (`{"text": ...}`) store only confident table matches and return the rest in `needs_confirmation` and `unmatched`.

For Tester's runner the defaults already match: `ITEMS_PATH=items`,
`ITEM_NAME_PATH=name` (or `dish_id`), `KCAL_PATH=total.kcal`,
`PROTEIN_PATH=total.protein_g`, `AI_FLAG_PATH=used_ai`, `ITEM_AI_PATH=ai_estimate`.

## Other routes

| Route | What |
|---|---|
| `GET /v1/dishes` | Full dish table (public; same file the app ships offline) |
| `POST /v1/entries` | Save chips: `{local_date?, slot?, text?, items:[{dish_id, qty, unit, oil_level, source, confirmed}] or [{custom_name, kcal, protein_g, source, confirmed}]}` (see Saving rules). Dish rows are recomputed server-side from the table. Slot defaults by time: <11 breakfast, 11-16 lunch, 16-19 snacks, else dinner. With only `text`, saves what the table recognised and returns `unmatched`. 201 → `{entries, unmatched, summary}` |
| `GET /v1/entries?date=` | Day's entries + `total` |
| `GET/PATCH/DELETE /v1/entries/{id}` | Edit a chip (`qty, unit, oil_level, dish_id, slot, local_date, custom_name, kcal, protein_g, if_unmodified_since`); stale `if_unmodified_since` → 409 with the server copy. Delete is soft (204) |
| `GET /v1/sync/entries?since=RFC3339` | Changed entries incl. soft-deleted, for the app's SQLite copy (last-write-wins by `updated_at`) |
| `GET/PATCH/DELETE /v1/me` | Profile basics, `diet` (veg/egg/nonveg), `steps_in_budget`; DELETE erases account and all data |
| `PUT /v1/profile` | Onboarding `{sex, birth_year, height_cm, weight_kg, activity_level, goal: fat_loss\|maintain\|muscle_gain}` → computes target (Mifflin-St Jeor ±goal, protein 1.6/1.2 g/kg, fat 25%, carbs rest) |
| `GET /v1/targets?date=`, `PUT /v1/targets` | Target in effect on a date; manual override (history kept by `effective_from`) |
| `POST /v1/activity/steps` | Health Connect day totals `{source:"health_connect", days:[{date, steps, external_id?}]}`; re-sending a day replaces it |
| `GET /v1/activity/steps?date=` | Steps + estimated kcal burned |
| `GET /v1/summary?date=` | Shared daily summary: kcal_in, protein_in, kcal_out, steps, water_ml, logged, streak_day |
| `GET /v1/streak` | current, best, freezes_left (this Mon-Sun week), logged_today, freeze_saved_on |
| `GET /v1/coach/suggestions?date=` | `{remaining, message, options[3]}`; each option has `items` ready to POST to /v1/entries |
| `GET /healthz` | Liveness |

## Parser notes
- Hindi script: known Devanagari words and digits are transliterated (`devanagari_words` in rules.json); unknown ones land in `unmatched`.
- Pieces: dishes with `piece_grams` (momos, pani puri...) read a bare number as pieces ("8 momos").
- Combos with `parts` (chole bhature, rajma chawal...) are split into parts when a portion is given; without one they stay a single item.
- Fats (ghee/butter/oil) are always spoons, capped at 6; a trailing quantity after a fat binds to the main dish.
- `x2` / `2x` multiply the previous dish; "packet" = one standard pack portion.
- Typo matching needs at least 0.8 similarity, word lengths within 1, the same first letter, and never turns a protein word into a different word ("soya chaap" never becomes chaas).
- "X with Y, 1 bowl" shares the bowl between X and Y in proportion to their standard portions (fats excluded).
- Modifiers pick a variant row: "paratha with aloo filling", "aloo bhara paratha", "veg momos", "chicken steamed momos".
- Egg counts go to the egg dish: "teen ande ka omelette" = omelette for 3 eggs, not boiled eggs.

## App contract for POST /v1/entries items (katoricount-app)
- `client_id` (string, max 100): idempotent per user. Sending a client_id that already exists returns the stored entry unchanged (in `entries`, listed in `duplicates`); the response is 200 if every item was a repeat, else 201. To change an entry use `PATCH /v1/entries/{id}`; `{id}` may be the server id or the client_id (GET and DELETE too).
- `dish_table_version` (int): the table version the client's numbers came from (current: max `version` in dishes.json, now 1).
- `kcal`, `kcal_low`, `kcal_high`, `protein_g`, `protein_low`, `protein_high`, `carbs_g`, `fat_g`: what the user confirmed. For table items (dish_id + source table/did_you_mean/generic) the server checks them against that table version and **rejects mismatches, never silently recalculating**:
  - numbers without `dish_table_version`: 400
  - any version the server has published (older ones too) is checked against that version; a version it has never seen: 409 keep-and-retry (see "Dish table versions")
  - kcal off by more than max(2 kcal, 2%) or protein by more than max(0.5 g, 3%): saved with the
    server's own numbers for that dish, qty and unit, `state: "corrected"` (201, not 422). See
    "Hard-gate rules (065fefd+)" below
  - ranges that don't contain the best guess: 422
  - otherwise the client's numbers are stored as sent (carbs/fat default to table estimates).
  Table items sent without numbers are computed from the table version sent, or the current table if none is sent.
- Stored per entry: client_id, dish_table_version, confirmed, carbs_g, fat_g (migration 003). Entry responses include them.

## Confidence and confirmation

Each parse item has `confidence` (0-1) and `flags` explaining deductions
(`fuzzy`, `trailing_qty`, `leftover_nearby`, `leftover_in_meal`,
`combo_or_split`, `variant`, `generic`, `sanity`, `capped`, `count_between`,
`style_ignored`). Below `rules.json > confidence.threshold` the item gets
`source=did_you_mean` and `needs_confirmation=true`. A meal with leftover
unknown words (`leftover_in_meal`), or that used a split/combo rule, flags every
affected item — never a confident one-tap save while unmatched words remain.

"X with Y, 1 bowl" = one serving in total: the combo row if the table has one
(e.g. rajma chawal), otherwise one serving split by the parts' calorie share.
Always flagged. A combo given in its own unit ("1 plate rajma chawal") stays a
single row and is not flagged.

`POST /v1/entries` with `text` only saves confident items. If nothing is
confident it returns 200 with `entries: []` and the `needs_confirmation` list.

## AI fallback

**The "Strict rule and queue" section below replaces the per-span batching and
the per-minute limiter described in this section.**

- At most **one AI call per meal**. All unknown spans are sent in one batch, with
  their leading counts removed (counts are applied afterwards).
- **Shared cache** keyed on normalized text (lower case, no punctuation,
  single spaces). A cache hit makes no call and returns `fallback: "cache"`.
  Cached answers are still `source=ai_estimate`, `needs_confirmation=true`.
  The cache only stores raw AI answers, never user corrections.
- AI answers under or equal to 0 kcal, or at least 3000 kcal per item, are
  rejected. They are not cached or shown, and the job ends as `error` (see below).
- Caps (see "AI quota, retries and fallback_reason" below): `AI_USER_DAILY_CAP`
  per user per day (default 3; `fallback: "cap_reached"`, `fallback_reason: "user_limit"`)
  and the project-wide `AI_DAILY_CAP` (default 20; `fallback: "global_cap_reached"`,
  `fallback_reason: "daily_limit"`). When either cap is reached, the meal ends
  as failed (see below): no generic kcal.
- A per-minute limit across the whole project (`AI_PER_MINUTE`, default 8;
  set it below 0 for no limit). Over the limit, the meal is queued and waits.
  The limiter runs inside each server process, so with several instances set it
  per instance.
- `AI_MODE=gemini` makes one REST `generateContent` call
  (`GEMINI_MODEL`, default gemini-flash-latest) with a strict JSON
  `responseSchema` and an 8-second timeout. `thinkingConfig` is per model (see
  `GEMINI_THINKING_BUDGET` below). Bad JSON, invalid ranges or spans that
  weren't asked about end the job as `error`. A busy provider
  (rate_limited / unavailable / timeout) requeues the job instead (see below).
- `fallback` values: none | cache | used | not_configured | cap_reached | global_cap_reached | daily_limit | busy | rate_limited | error (see `fallback_reason`).
- Weekly review: `go run ./cmd/aicache-export -days 7 -limit 50 > top.csv`
  lists the most-hit cached answers. A cached dish becomes a table row only by
  adding it to dishes.json by hand, checked against a real source.

## Remembered foods (per-user learned readings)

When the user saves a confirmed item with `span` (the parse item's
`matched_text`), the reading is stored for that user only. On the next parse,
that span comes back as `source=table`, `learned=true` and
`needs_confirmation=false`. A later confirmation overwrites it.

- `GET /v1/remembered` returns `{"remembered":[{id, span, dish_id, custom_name, qty, unit, oil_level, kcal_best, kcal_low, kcal_high, protein_best, protein_low, protein_high, carbs_g, fat_g, uses, updated_at}]}`.
- A `PATCH /v1/entries/{id}` that changes the dish, quantity, unit, oil level, name, or numbers is also remembered. It uses the entry's stored `span` (saved on create), or `span` in the PATCH body if one is sent. Send `"remember": false` to skip.
- `DELETE /v1/remembered/{id}` resets one remembered food. It returns 204, or 404 if the id is not yours.
- `DELETE /v1/remembered` resets all of them and returns `{"deleted": n}`.

## Test hooks (AI_MODE=stub only; 404 in every other mode, no auth)

- `GET /test/ai/calls` returns `{"calls": n, "global_daily_cap": n}`.
- `POST /test/ai/calls/reset` sets the call count to 0 and clears the AI cache plus the per-user and global AI counters.
- `POST /test/ai/next-answer` with `{"items":[{name, quantity, unit, kcal:{low,best,high}, protein_g:{low,best,high}}]}` makes the next AI call (for the whole meal) return these items.
- `POST /test/ai/daily-cap` with `{"cap": n}` sets the project-wide daily cap. 0 means unlimited.

## Dish table versions

The server keeps a snapshot of every dish table version it has published, in
the `dish_table_versions` table. On startup it stores the current table. If a
table with different contents is published under an existing version number,
startup fails: every change to `dishes.json` must bump the version.

An entry that sends `dish_table_version` is checked against the snapshot for
that version, including older ones such as entries made offline before an
update. The entry is stored with the version it sent. Numbers that don't match
that version's values are saved `state: "corrected"` with the server's numbers.

If the server has never seen the version (for example, the app was updated
before this server), it returns **409**:

```json
{"error": "unknown_dish_table_version", "keep_entry": true, "retry": true,
 "dish_table_version": 8, "server_version": 7, "item": 0,
 "message": "Keep this entry on the device and retry later. The server doesn't know this dish table version yet."}
```

The client should keep the entry and retry later. This replaces the earlier
rule that returned 409 for any version that wasn't the current one.

## Entry state and streaks

Each entry has a `state` (migration 007):
- `confirmed` (default): counts in calorie and macro totals.
- `needs_review`: logged but not yet checked, for example saved offline, or
  waiting on an AI estimate or a did_you_mean confirmation. Send
  `"state": "needs_review"` on a `POST /v1/entries` item. These items skip the
  confirmation and number checks. `dish_id` or `custom_name` is required. Any
  numbers are optional display estimates; a known `dish_id` gets table numbers.

`needs_review` entries are **left out of** every total: the `/v1/entries` day
`total` (which also reports `needs_review: n`), `/v1/summary` kcal_in and
protein_in, and the coach's remaining budget.

**Streak rule:** a local date counts toward the streak if the user logged
anything for it, including `needs_review` entries.

To confirm, send `PATCH /v1/entries/{id or client_id}` with
`{"state": "confirmed", ...}`. The normal save rules apply, so a custom item
must include `kcal`. Once confirmed, the entry counts in totals. Learned
readings are only remembered from confirmed entries.


## Strict rule and queue (replaces earlier AI-fallback behaviour)

**The table answers a meal only if all of these hold:**
- every span is an exact or alias match;
- every span has a count or unit stated in the text (`rules.json >
  strict_require_stated_quantity`, default true);
- nothing is left over, and no fuzzy match, split, combo or generic row was
  used;
- no item has a flag or needs confirmation.

A remembered food (learned reading) counts as a clean table match. This
includes a remembered reading for the whole meal text.

If the table answers, `POST /v1/parse` returns **200** with `answer: "table"`
and `status: "done"`.

**Otherwise the whole meal text goes to the AI in one call.** The rule-based
parse is included in the prompt only as a hint. Every AI item comes back with
`source=ai_estimate`, `needs_confirmation=true`, and kcal and protein ranges.
- **Cache hit** (the whole meal's normalized text): 200 with `answer: "ai"` and
  `fallback: "cache"`. No call is made.
- **Otherwise** the meal is queued: **202** with
  `{"status": "pending", "job_id": "...", "fallback": "queued", "items": [], ...}`.
  Poll `GET /v1/parse/jobs/{job_id}`. It returns 202
  `{"status": "pending", "ai_state": "estimating", "queue_length": n, ...}` until the
  answer is ready (after a requeue it also has `requeues`, `busy_reason`,
  `next_attempt_at`), then 200 with the full parse response. The field the app
  reads to tell estimating from failed is **`ai_state`**: `"estimating"` while
  the job is pending, `"answered"` when the AI (or cache) filled the row,
  `"failed"` when no AI answer is coming. Jobs belong to the user who created
  them (404 for anyone else) and expire after one hour.
- The queue runs in the server process and drains at `AI_PER_MINUTE`
  (default 8). A queue that is full (500 jobs) ends the meal as failed
  (`fallback: "busy"`, `fallback_reason: "error"`, `ai_state: "failed"`).
  Pending jobs are lost on restart; the app should save the meal as
  `needs_review` and parse it again later.
- AI not configured, or `use_ai: false`: 200 with `answer: "generic"`. This is
  the rule-based guess with every item set to `needs_confirmation`, plus
  placeholder cards for unknown text.
- A per-user or project-wide daily cap, or an AI error / bad answer: the meal
  ends as failed (`ai_state: "failed"`, no generic kcal, see "AI quota,
  retries and fallback_reason"). A busy provider (429/503/timeout) keeps the
  job pending and requeues it.

`POST /v1/entries` with only `text` now saves items only if the meal passes
the strict rule. Otherwise every item comes back in `needs_confirmation`.

## Field names

Entries use **`protein_g`**. `protein` is also accepted as an alias on
`POST /v1/entries` items and on `PATCH`. Parse items return
`protein_g: {low, best, high}`.

## Tests

The integration tests create a throwaway database with a unique name
(`ct_run_<random>`) for each run and drop it afterwards. They never touch
`calorie_test`. `TEST_PG_ADMIN_URL` must be a role that can create databases
(default `postgres://calorie:calorie@localhost:5432/postgres`).

## Admin (needs `ADMIN_TOKEN`)

Send `Authorization: Bearer <ADMIN_TOKEN>`. The token must be at least 24
characters. A missing or wrong token returns 401. If `ADMIN_TOKEN` isn't set,
these routes don't exist (404).

- `GET /admin/ai-cache/top?days=7&limit=50[&format=csv]` lists the most-hit
  cached AI answers used in the last N days, with hit counts. JSON is
  `{"days": 7, "top": [{text, hits, first_seen, last_hit, items: [...]}]}`.
  CSV has one row per item. The CLI does the same:
  `go run ./cmd/aicache-export -format json|csv`.
- `POST /admin/dishes/import` with
  `{"note": "...", "items": [{<dish row as in dishes.json>, "from_cache": ["meal text", ...]}]}`
  takes items that were checked by hand. Each item needs a `source` (not
  `ai`) and a non-empty `source_note` saying where the numbers were checked.
  New ids are added and existing ids are replaced. The whole table is
  validated (unique snake_case ids, ranges, no alias clashes; 422 on
  failure). Then it is published as **a new dish table version**, the
  running server switches to it at once, and the `from_cache` entries are
  removed from the AI cache. Returns 201
  `{dish_table_version, added, replaced, dropped_cache}`. Older versions
  stay valid for offline entries. After a restart, the newest published
  version wins.
- To keep the repo and the app's offline copy canonical, run
  `go run ./cmd/dishes-pull > internal/dishes/dishes.json` and commit the
  result. Until you do, a server built from an older `dishes.json` still
  starts and uses the newer published table.

## Default portions (`strict_require_stated_quantity: false`)

The table also answers a meal when a span is an exact or alias match but has
no count or unit typed, for example "palak paneer". That item uses the dish's
standard portion, makes no AI call, has `needs_confirmation: false`, and has
**`default_portion: true`**. The app can show "Read as: 1 katori · Change".
Adding the item normally confirms it.

A `POST /v1/entries` with only `text` never saves `default_portion` items on
its own. They come back in `needs_confirmation` for the app to confirm. Items
with a stated count are saved as before.

Combo rows (dal chawal, rajma chawal, chole bhature, kadhi chawal), generic
rows, typo matches and leftovers still go to the AI.

## Everyday combos

`rules.json > everyday_combos` lists combo rows that are read as their
component dishes at the components' default portions. No new nutrition data
is added. They are exact table matches and make no AI call. Each part comes
back as a separate item with `from_combo: <combo id>`, `default_portion: true`
and `needs_confirmation: false`.

| Combo | Parts |
|---|---|
| dal chawal / dal rice | dal + rice |
| rajma chawal | rajma + rice |
| chole chawal | chole + rice |
| kadhi chawal | kadhi + rice |
| chole bhature | chole + 2 bhatura |
| bread butter | bread + butter (default spoon) |

This also applies when the combo comes with its own unit: "2 plate dal
chawal" gives 2 × each part. Other everyday pairs, such as idli sambar, dosa
chutney, pav bhaji, vada pav, roti sabzi and curd rice, already parse as
clean table items.

A combo given in a different unit ("1 katori chole bhature") still uses the
split rule and goes to the AI.

"bread butter" used to go to the AI because it matched the `bread_butter`
combo row, and the strict rule never lets combo rows answer alone.

## Spans, AI contract and overconfidence rules (current; replaces earlier AI notes where they conflict)

**`span_start` / `span_end` on every item.** These are character offsets
into the user's original text, end exclusive, counted in **UTF-16 code
units**, which is how JS string indices count. So
`text.slice(span_start, span_end)` works in the app, Hindi script included.

**AI only fills the gaps.** Confident table items, and remembered foods, keep
their spans; these are the claimed spans.
- The AI gets the whole text for context, plus the **unclaimed spans**
  (offsets and substrings, with noise such as numbers, connectors and fillers
  dropped).
- It must return items only for those spans, each with
  `span_start`/`span_end`/`span_text`.
- AI items that overlap a table item are dropped.
- An AI item with no valid position becomes `did_you_mean` with
  `needs_confirmation=true`, flagged `ai_unplaced`, and is put on the first
  unclaimed span.
- An AI item never gets a whole-text span while table items exist.
- A table word glued to unknown words ("kuttu cheela") is not claimed; the
  whole phrase goes to the AI.
- AI items keep the user's own words as `matched_text`. The AI's dish name is
  in `ai_name`.
- The cache key is the normalized text plus the claimed spans
  (dish id @ offsets).
- The stub (AI_MODE=stub) follows the same contract: one item per unclaimed
  span, named with the span's own words. Next-answer overrides are returned
  verbatim, so bad offsets reach the server guard (overlaps with table items
  are dropped; unplaceable items become did_you_mean flagged ai_unplaced).

**Remembered foods** are keyed on the user's own text: the span, or the whole
meal. A remembered whole-meal text, or a remembered unclaimed span, is
applied before any AI call.

**Linking entries to AI jobs.** `POST /v1/entries` items and `PATCH` accept
optional `parse_job_id` (alias `job_id`) and `client_item_id`.
`GET /v1/parse/jobs/{id}` lists the entries saved with that job id.

**Overconfidence rules.** These flags always need a decision:
- `token_reuse`: one input token feeds at most one item.
- `adjacent_split`: adjacent dishes must form an everyday pair or combo.
- `unit_mismatch`: a count or unit must fit the dish's unit ("2 egg curry",
  "1 glass roti").
- `leftover_in_meal`: the meal has unmatched leftover words the parser could
  not use. Every item is flagged, `needs_confirmation=true`, and
  `one_tap_ok=false` — a missing side can never save as a confident complete
  meal. Unused form words that do not change the dish ("dal curry") also land
  here instead of being silently absorbed.
- `leftover_nearby`: an unclaimed word sits directly next to the dish
  ("ragi roti", "roti zorbo", "zorbo roti"); the whole phrase is unsure and the
  AI item for that phrase carries the flag too. A separator between them
  (`aur`, `and`, `with`, `,`, `और`, `के साथ`) or a new quantity starting the
  unknown part ("2 roti 1 plate zorbo") keeps the dish confirmed. Fillers,
  units and modifiers are skipped when looking for the neighbour.
- `fractional_combo`: a fractional portion (half, aadha, 1/2, quarter, dedh) of
  an everyday combo; every part is scaled, and the user confirms.
- `egg_count`: an egg count on an egg-in-gravy bowl dish ("egg curry 3 eggs",
  "3 ande ki curry"): one bowl (eggs_per_portion eggs) plus the extra eggs as
  boiled-egg pieces, each part with its own span.

Claims first: confident table items are claimed and only unclaimed spans go
to the AI. AI items are placed only by `span_start`/`span_end` or `span_text`;
an item with no position is never placed by its name (`ai_unplaced`).

Invariant (tested): no confident table item's span overlaps another item's.


## Hard-gate rules (current; replace earlier notes where they conflict)

### AI failure keeps the table's answer
When the AI isn't used or fails (`fallback` = error, busy, gave_up, cap_reached,
global_cap_reached, not_configured, or `use_ai:false`), confident table matches stay `source: "table"`,
`needs_confirmation: false`, no flags. Only the unclaimed spans become `generic` placeholders to
confirm (with `custom_items`). Example: `2 roti aur 1 plate zorbu` -> roti (table) + placeholder for
`1 plate zorbu`.

### No unknown words, no AI call
The AI is called only for a span holding a word nothing in the parse used (or a generic /
`leftover_nearby` / `compound_name` phrase). Counts, units and number words ("ek", "half plate",
"2 egg ka") don't count as unknown. Fuzzy matches (`rotti`), split list items (`sambar chutney`)
and `unit_mismatch` items cover their own words: they come back as `did_you_mean` to confirm and
the meal makes no AI call (`answer: "table"`, `fallback: "none"`).

### Valid units per dish (supersedes the unit_mismatch triggers below)
Every dish row has `units: [{unit, grams, source}]`, the units it comes in with the gram weight and
where that weight comes from (`idli` plate = 2 idli = 80 g; `momos` plate = 6 pieces = 180 g,
Hyprote). A bare number is the dish's counting unit and is valid (`2 dal` = 2 katori, `1 plate idli`
= 80 g, both confirmed). `unit_mismatch` is only for a typed unit the dish doesn't list, or a count
above `plausible_max` for that unit (`8 plates momos`, `6 katori dal`).

### Counting units and plausible counts
- A bare number means the dish's counting unit: `piece` when the dish has `piece_grams` (momos:
  `8 momos` = 8 pieces, 400 kcal), otherwise the dish unit (`count` for idli, samosa, roti; `katori`
  for dal, sabzi).
- `rules.json` `plausible_max` gives the largest sensible count per unit (plate 3, katori/bowl/glass 4,
  cup 5, count 12, piece 15, slice 8). A count above it (`8 plates momos`, `6 katori dal`), a counted
  dish by the plate/katori (`1 plate idli`) and a bare count on a katori dish (`2 dal`) are flagged
  `unit_mismatch` and need confirmation. Never guessed.
- Every `unit_mismatch` item carries `unit_options`: `[{qty, unit, kcal}]` with at least the
  counting-unit reading and the stated reading, e.g. `8 plates momos` ->
  `[{"qty":8,"unit":"piece","kcal":400},{"qty":8,"unit":"plate","kcal":2400}]`
  (plus one standard portion when the stated unit is the counting unit).
- Items with `unit_options` are left out of `total` until the user picks one and saves it; the
  saved entry is recomputed by the server from the chosen qty and unit.

### Unverified estimates (`estimate_unverified`)
A dish row with `"estimate_unverified": true` in dishes.json has published sources that
disagree too much to trust one number (today only `bhel_puri`: DietGhar ~171, Khaana 221
kcal/100 g, Cookd ~135 per serving). It still parses as that dish with no AI call, but the
item always carries flag `estimate_unverified`, `needs_confirmation: true` and source
`did_you_mean`, so it is never a confident table save: a save without confirmation is
treated like any other unconfirmed item (needs_review / 409 confirm path).

### Compound names (rule 2)
Any two adjacent table matches with no separator or quantity between them that aren't one
`everyday_combos` row and aren't a listed pair of whole dish names in `rules.json`
`everyday_pairs.dish_pairs` (the frozen list: roti sabzi, idli sambar, chai biscuit, poha chai,
bread omelette, ...; either order; category pairs are gone) are flagged `compound_name` +
`adjacent_split` and are never confident. By default they come back as `did_you_mean` items to confirm
with no AI call (food.Service.CompoundToAI = false; true sends the phrase to the AI instead).
Earlier text: two adjacent table matches where the first is a bare
ingredient word (`protein_words` or `rules.json` `name_qualifier_words`: egg, chicken, paneer, aloo,
...), read as one dish name (`egg rice`, `chicken pulao`, `paneer roti`). Both get `compound_name`
and `adjacent_split`, are never confident, and the whole phrase goes to the AI. Only
`everyday_combos` and `everyday_pairs.dish_pairs` split.

### Trailing quantities stop at separators
`poha 1 plate aur chai`: the `1 plate` belongs to poha; it never moves past aur/and/with/comma.

### Saving: state "corrected"
- Table items (`dish_id` + `source` table/did_you_mean/generic): the server always recomputes from
  dish, qty, unit and oil level. Client kcal/protein that don't match (for example a plate's kcal sent
  with `unit: "piece"`) are not stored and not rejected: the entry is saved with the server's
  numbers and `state: "corrected"`. Corrected entries count in totals like confirmed ones and are
  not remembered as the user's reading. Clients can't send `state: "corrected"`; only `confirmed` or
  `needs_review`.
- AI estimates may send `kcal_per_unit` (> 0, <= 3000; 400 otherwise, and only with
  `source: "ai_estimate"`). `kcal` must equal `kcal_per_unit x qty` (within max(2 kcal, 2%));
  missing kcal is filled in, a mismatch is saved as `kcal_per_unit x qty` with `state: "corrected"`.

- A table dish sent in a unit it doesn't come in (poha or dal with `unit: "piece"`) is never
  confirmed at the client's numbers: saved `state: "needs_review"` with the server's numbers for its
  own unit, out of totals until confirmed with a valid unit.
- `kcal_per_unit` on any non-`ai_estimate` item (including table items): 400.

### GET /version
`{"commit": "<short sha>", "built_at": "<RFC3339>", "dirty": bool}`. Commit and time come from
`-ldflags "-X github.com/akarsh/calorie-tracker/internal/app.Commit=... -X ...app.BuiltAt=..."`, else
Go's embedded VCS info.

### Portion changes (dish table version 2)
| dish | old | new | source |
|---|---|---|---|
| samosa | 80 g, 260 kcal, 4 g protein | 75 g, 233 kcal, 3.9 g | USDA FDC FNDDS 2708730 (310 kcal/100 g, "quantity not specified" 75 g) |
| pani_puri (plate) | 150 g (25 g/piece), 250 kcal, 5 g | 120 g (6 x 20 g), 185 kcal, 4.4 g | DietGhar recipe calc https://www.dietghar.com/foods/pani-puri ; Haldiram label 6 puri = 180 kcal |
| dhokla (piece) | 30 g, 50 kcal, 2 g | 30 g, 80 kcal, 3.4 g | Clearcals recipe https://clearcals.com/recipes/dhokla/ |

### Test hook: POST /test/ai/fail (AI_MODE=stub only, same guard as next-answer)
`{"mode": "error" | "timeout" | "busy" | "unavailable" | "daily_limit" | ""}`: every following AI call fails that way until mode `""` or
`/test/ai/calls/reset`. `error` ends the job as failed (`fallback: "error"`). `busy`, `unavailable` and `timeout` keep it
pending (requeued) until the mode is cleared or `AI_REQUEUE_MAX_MINUTES` runs out (`gave_up`). `busy` is a 429 (not
charged on a later attempt); `unavailable` is a 503 (charged when it reaches Gemini on a later attempt).
`daily_limit` ends it as failed (`fallback: "daily_limit"`). Confident table items survive.

### AI quota, retries and fallback_reason
Settings (all env vars):

| Setting | Default | Meaning |
|---|---|---|
| `AI_DAILY_CAP` | 20 | Project-wide AI meals per quota day (Gemini free tier: 20 requests/day/model, quotaId `GenerateRequestsPerDayPerProjectPerModel-FreeTier`). 0 = unlimited. `AI_GLOBAL_DAILY_CAP` is still read as the old name. |
| `AI_USER_DAILY_CAP` | 3 | AI meals per user per quota day, so one user can't use up the day. Below 0 = no per-user limit. |
| `AI_REQUEUE_MAX_MINUTES` | 30 | How long a busy Gemini job (`rate_limited` / `unavailable` / `timeout`) keeps being requeued, from its first try, before it ends as `gave_up`. |
| `AI_QUOTA_RESET_TZ` | `America/Los_Angeles` | The caps reset at midnight in this zone, when Google resets its daily quota (12:30 PM IST in PDT, 1:30 PM IST in PST). The `ai_usage` / `ai_global_usage` `local_date` is the date in this zone. |
| `GEMINI_RPM` | 10 | Global limiter: Gemini HTTP attempts (retries included) are spaced to at most this many a minute across the process; queued jobs wait for a slot instead of bursting. A slot that can't come before the job's deadline is not taken (`rate_limited`). |
| `GEMINI_MODEL` | `gemini-flash-latest` | The generateContent model. |
| `GEMINI_THINKING_BUDGET` | _(per model)_ | Controls `generationConfig.thinkingConfig`. Empty = model default: `thinkingBudget: 0` for `gemini-flash-latest` (a lookup, so the answer stays inside the 8s timeout); omitted entirely for Flash-Lite models (`*flash-lite*`), which reject `thinkingBudget` with HTTP 400 `INVALID_ARGUMENT`. `omit` (or `none` / `off`) never sends `thinkingConfig`. A non-negative integer sends that `thinkingBudget` for any model. |
| `AI_PER_MINUTE` | 8 | The job queue's drain rate (unchanged). |

**Retries.** On HTTP 429 or 503 the client retries at most 2 times (3 HTTP attempts per meal). The wait is
`Retry-After` (seconds or HTTP date) if present, else the `google.rpc.RetryInfo` `retryDelay`, else
exponential backoff with jitter (1 s, then 2 s base; a random 50-100% of it). A retry that wouldn't
finish inside the job's time limit (30 s) is not made. Each attempt has an 8 s timeout, capped by the job's deadline.
Other statuses (400, 403, 500 ...) and timeouts are not retried. A 400 means
our request was bad (for example a `thinkingConfig` the model rejects): it is
logged as `bad_request`, ends the meal as `error`, and never marks Google's
daily quota exhausted.

**Daily quota.** A 429 whose `QuotaFailure` names a per-day quota (`quotaId` contains `PerDay`) is never retried:
the project is marked exhausted until the next reset (`AI_QUOTA_RESET_TZ` midnight). Until then the server makes
no Gemini calls: parses answer at once as a failed meal (`ai_state: "failed"`, `fallback: "daily_limit"`,
`fallback_reason: "daily_limit"`, `ai_resets_at`; no generic kcal). The mark is stored in Postgres
(`ai_google_exhausted`, keyed by the Pacific quota day) so a process restart keeps it; it clears when the
quota day rolls (or when `exhausted_until` is past).

**How attempts are counted.** One meal reserves ONE unit of the per-user and project caps (`AI_USER_DAILY_CAP`,
`AI_DAILY_CAP`) before it is queued: that covers the first attempt, even if Gemini answers 429. HTTP retries
inside one attempt are not counted again. Each **later** attempt (a busy requeue) that fires and reaches
Gemini is charged one more unit against both caps: any HTTP response except 429, or no response (timeout),
counts as reaching Gemini. A 429 means Google rejected the request before running it, so that send is not
charged. An attempt that never sends (no `GEMINI_RPM` slot before the deadline, etc.) is not charged. When
`AI_DAILY_CAP` is already used up, a later attempt is not made and the meal ends as `daily_limit`. A meal that
ends as failed (error, daily_limit, gave_up) keeps whatever was already charged. Meals answered from the cache,
the table, or rejected before reserving (`daily_limit` already known) are not counted. A meal rejected because
our own queue is full (`AI_QUEUE_MAX`) gives its reserved unit back.

**Busy means requeue, not a fallback number.** When Gemini is still busy after the retries
(`fallback_reason` `rate_limited`, `unavailable` or `timeout`: a 429 or 503, the limiter having no slot in
time, or the call timing out), the job is NOT answered with generic kcal. It stays `status: "pending"`,
`ai_state: "estimating"`, and goes back into the queue after a delay. The late answer fills the same job id.
The delays are 30 s, 1 min, 2 min, 3 min, 4 min, then 5 min (the last repeats every 5 min). A job is
requeued until **`AI_REQUEUE_MAX_MINUTES`** (default **30**) after its first try; the last try is scheduled
so that it finishes inside that window. A requeued job still respects `GEMINI_RPM` and `AI_PER_MINUTE`.
A later attempt that reaches Gemini is charged against the caps (see above); a 429 or a send that never
leaves is not. While it waits, the job poll adds `requeues`, `busy_reason` (the last busy
reason) and `next_attempt_at` (RFC 3339). When the window runs out the job ends as failed with
`fallback: "gave_up"`, `fallback_reason: "gave_up"`. A finished job stays pollable for an hour after it
finishes (so a job that used the full window is still there).

**Failed means the user types the calories.** Only `daily_limit`, `user_limit`, `error` and `gave_up` end a meal as
failed: `ai_state: "failed"`, `status: "done"`, `answer: "none"`. Confident table items stay in `items` as
they are. Each open span is listed in `failed_spans` (`{span_start, span_end, text}`), `unmatched` and
`custom_items` (`needs_input: true`) with **no kcal at all** - there is no generic estimate. The row is the
failed row; the user types the calories.

**fallback_reason** (machine-readable):

| fallback_reason | ai_state | When | Extra fields |
|---|---|---|---|
| `user_limit` | `failed` | this user's `AI_USER_DAILY_CAP` is used up (`fallback: "cap_reached"`) | `user_daily_limit`, `ai_resets_at` |
| `daily_limit` | `failed` | the project-wide quota is used up: `AI_DAILY_CAP` (`fallback: "global_cap_reached"`) or Google's daily quota (`fallback: "daily_limit"`) | `ai_resets_at` |
| `rate_limited` | `estimating` | 429 still failing after the retries, or our limiter had no slot in time: the job is requeued (`busy_reason` on the poll) | |
| `unavailable` | `estimating` | 503 still failing after the retries: the job is requeued | |
| `timeout` | `estimating` | the call timed out: the job is requeued. `timeout` only ever means busy, still estimating | |
| `gave_up` | `failed` | the `AI_REQUEUE_MAX_MINUTES` window ran out while Gemini was still busy (`fallback: "gave_up"`) | |
| `error` | `failed` | anything else: other HTTP errors, bad JSON, implausible or unplaceable answers, or our own queue being full (`fallback: "error"`, or `"busy"` when the queue is full) | |

`ai_resets_at` is RFC 3339 (e.g. `2026-10-16T00:00:00-07:00`). Messages: user_limit "You've used today's {n} AI
estimates. Add the calories yourself.", daily_limit "AI estimates are used up for now. Add the calories yourself.",
error / gave_up "Couldn't estimate this. Add the calories yourself."

**Logging.** Each failed attempt logs `model`, `attempt=n/3`, `http_status`, Google's `error.status` and `error.code`
(e.g. `RESOURCE_EXHAUSTED` 429), the kind, `latency_ms` and the retry wait; the job result logs the fallback and
reason. The API key, the prompt/request body and the answer text are never logged.

### GET /admin/ai-quota (ADMIN_TOKEN)
`{"quota_day": "2026-10-15", "reset_zone": "America/Los_Angeles", "resets_at": "2026-10-16T00:00:00-07:00",
"daily_cap": 20, "used": 7, "remaining": 13, "user_daily_cap": 3, "exhausted": false}`; `remaining` is null when
`daily_cap` is 0 (unlimited) and 0 with `exhausted: true` plus `exhausted_until` after a daily-quota 429.

### one_tap_ok (every parsed item)
`one_tap_ok: true` only for a confident table item the user can save with one tap: `source: "table"`,
`needs_confirmation: false`, not an AI estimate, no `unit_options`, and no flag that needs a choice
(unit_mismatch, estimate_unverified, compound_name, adjacent_split, fuzzy, generic, combo_or_split,
leftover_*, token_reuse, fractional_combo, egg_count, needs_review). Everything else is `false`: AI estimates,
did_you_mean, generic placeholders, anything with `needs_confirmation`. Harmless flags (e.g. `trailing_qty`) don't
block it. Items listed under a text save's `needs_confirmation` are always `false`.

### Variant choice, time words, vague amounts (dish table v3)
- A bare base dish whose table variants differ by more than `variant_spread` (15%) kcal at the applied portion, with no row named by that word (today: `biryani` → veg/chicken/mutton/egg; `chilla` → besan/moong), is never guessed: the item carries flag `variant_choice`, `needs_confirmation: true`, `one_tap_ok: false`, and `variant_options: [{dish_id, name, kcal, protein_g}]` at the parsed portion. `kcal.low/high` span all variants.
- `aadha` / `adha` / `half` = 0.5 of the counting unit.
- Time words (`temporal_words`: kal ka, bacha hua, aaj ka, …) are stripped before matching and never count as leftover.
- Vague amounts (`vague_quantity_words`: thoda, zyada, bahut, kam, …) not about oil add flag `vague_quantity` and force confirmation.
- When the AI cap is hit, a table dish next to unknown words ("roti zorbali") stays as an item to confirm; only the unknown words go to `failed_spans` / `custom_items`.

### 422 error shape (choice and profile checks)
`{"error": {"code": "<code>", "message": "...", ...}}`
- `variant_required` (POST /v1/entries): a table item whose `span` (or the request `text`) names only an ambiguous base dish ("biryani") was sent without `variant_dish_id`, or `variant_dish_id` != `dish_id` / not one of the options. Extra fields: `item` (index), `dish_id`, `variant_options: [{dish_id, name, kcal, protein_g}]` at the sent qty/unit. Fix: user picks; resend with `dish_id` = `variant_dish_id` = the pick. Nothing in the request is saved.
- `quantity_required` (POST /v1/entries): the span/text had a vague amount (`vague_quantity`: thoda, zyada…) and the item came without `confirmed: true`. Extra: `reason: "vague_quantity"`, `item`, `dish_id`. Fix: show the portion, resend with `confirmed: true`. Text-only saves (`{"text": ...}`) never save these; they come back in `needs_confirmation`.
- `profile_invalid` (PUT /v1/profile): extra `fields: {field: problem}`.

### PUT /v1/profile (changed)
Body: `{target_kcal, maintenance_kcal, goal (fat_loss|maintain|muscle_gain), diet (veg|egg|nonveg, optional), age, height_cm, weight_kg, activity_level}`. The phone's target is stored as sent (macros derived from it), never recomputed. Rejected with `profile_invalid` when target_kcal < 1200, maintenance_kcal outside [female MSJ, male MSJ] × activity for that age/height/weight (±2 kcal), or target_kcal < maintenance_kcal − 500 (±2). A `sex` field is accepted and ignored: never stored (migration 011 drops `profiles.sex`), logged or echoed. Response `{profile: {birth_year, height_cm, weight_kg, activity_level, goal, maintenance_kcal}, target}`.

### Brand words
A brand (`brand_words` + `brand_only_words` in rules.json: amul, britannia, good day, haldiram…) that no branded row matches counts as leftover: items get `brand_unmatched`, `needs_confirmation`, `one_tap_ok: false` ("amul masti buttermilk" no longer one-taps as plain buttermilk).

### Failed queued meals
A meal that was queued and ends failed (gave_up, daily_limit, error, bad_request) keeps table dishes next to unknown words as items to confirm; only unknown words go to `failed_spans` / `custom_items`, same as the first-send cap path.
