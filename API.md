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
  - kcal off by more than max(2 kcal, 2%) or protein by more than max(0.5 g, 3%): 422
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
unknown words, or that used a split/combo rule, flags every affected item.

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
  rejected. They are not cached or shown, and the span gets the generic
  confirm card.
- Caps: 20 AI calls per user per day (`fallback: "cap_reached"`), and a
  project-wide daily cap `AI_GLOBAL_DAILY_CAP` (default 200, 0 = unlimited;
  `fallback: "global_cap_reached"`). When either cap is reached, the span gets
  a generic confirm card (`source=generic`).
- A per-minute limit across the whole project (`AI_PER_MINUTE`, default 8;
  set it below 0 for no limit). Over the limit, the response has
  `fallback: "rate_limited"` and the span gets a generic confirm card. The
  limiter runs inside each server process, so with several instances set it
  per instance.
- `AI_MODE=gemini` makes one REST `generateContent` call
  (`GEMINI_MODEL`, default gemini-2.5-flash) with a strict JSON
  `responseSchema` and an 8-second timeout. Errors, timeouts, bad JSON,
  invalid ranges, or spans that weren't asked about become generic confirm
  cards (`fallback: "error"`).
- `fallback` values: none | cache | used | not_configured | cap_reached | global_cap_reached | rate_limited | error.
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
that version's values return 422.

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
  Poll `GET /v1/parse/jobs/{job_id}`. It returns 202 `{"status": "pending",
  "queue_length": n}` until the answer is ready, then 200 with the full parse
  response. Jobs belong to the user who created them (404 for anyone else)
  and expire after one hour.
- The queue runs in the server process and drains at `AI_PER_MINUTE`
  (default 8). A queue that is full (500 jobs) gives `fallback: "busy"`.
  Pending jobs are lost on restart; the app should save the meal as
  `needs_review` and parse it again later.
- AI not configured, or `use_ai: false`, or a per-user or project-wide daily
  cap reached: 200 with `answer: "generic"`. This is the rule-based guess with
  every item set to `needs_confirmation`, plus placeholder cards for unknown
  text.
- AI errors, timeouts, and answers outside 0-3000 kcal: the job finishes with
  `answer: "generic"` and `fallback: "error"`. These answers are never cached.

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

Invariant (tested): no confident table item's span overlaps another item's.
