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
