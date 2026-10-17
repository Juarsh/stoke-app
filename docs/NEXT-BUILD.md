# Next build (after closed-test-2)

Branched from `closed-test-2` (app 72b6eb4, backend e461c87). Backend work goes on
`next-build` in calorie-tracker. Order is CEO's (Oct 17, 2026).

## Top
1. [x] Edge (a): phone counts 0 and server 220, but the row only says "not counted". Make the phone count and show the server's numbers.
   Done: a flagged row (5xx save or delete) the server has stored but whose numbers the phone never knew is fetched with GET /v1/entries/{id} and counted at the server's copy, still flagged. A failed GET leaves it "not counted" and it is asked again at the next sync / app start.
2. [x] Edit dropped when a delete is refused: an edit still queued at that point is lost with no message, and the row shows the phone's qty while counting the server's 220. Restore qty and unit from the server row, or re-queue the edit.
   Done (CEO, Oct 17: always restore, never re-send): a delete that replaced an unsynced edit (queued, or flagged 5xx) is marked; if the server refuses it, the server's copy is read (GET, or the 409's copy) and the row ALWAYS takes the server's qty, unit and numbers (shown == counted). The edit is never re-sent; the note after the reason says "Your change to 3 pieces wasn’t saved. Edit it again if you still want it." If the copy can't be read, the row counts the server's last known numbers, flagged, with the same note.

## CEO-approved (Oct 17, evening)
- [x] Refused delete whose server copy can't be read either: the row showed the phone's qty while counting the server's last kcal. Now the amount reads "—" (Today "Dinner · Roti · —", Progress "· —"), kcal shown == counted, until a later read (every sync, every 30 s, app foreground, or tapping the Progress row) brings the server's qty, unit and numbers; then it shows the server's row. 404 then = gone.

## rg10 notes (Tester)
- [x] "Saved as 2 count" reads badly. Needs pieces wording.
  Done: 'count' is never a word in user copy: "Saved as 2 pieces · 220 kcal.", "dal isn’t measured in pieces" (was "by count"), the edit sheet's count chip reads "pieces" (now one shared "piece" chip, see below), "Did you mean … or pieces?", "kcal a piece" (unitWord / portionLabel); Designer later replaced the piece line with "That’s {n} kcal for one piece. Change the amount if yours is bigger or smaller." ({n} = kcal for one piece, shared kcal format; onePieceNote in labels.ts, __tests__/onePieceNote.test.tsx). Other units keep "Published recipes give … kcal a {unit}. Check it matches your {unit}.".
- [x] The note row uses Indian-style digit grouping, so 1,00,000 shows above 99,999.
  Done: checked first: every kcal in the app is en-IN grouped (ring, plate rows, Progress, Log, Add buttons, format.ts kc), so 1,00,000 is the app's format and the note rows already matched it. They (and the flagged rows, "Saved as", the plate rows and Progress) now all go through the one formatter kc, and "Saved as" kcal is rounded like every other kcal (it could print raw decimals). Switching the whole app to 100,000-style grouping would be a separate, app-wide CEO call.
- [x] 5xx path: no automatic retry once the server is back.
  Done: a row flagged after 3x 5xx (save or delete) retries by itself: on a backoff per row (30 s, doubling, max 30 min; app start counts as foreground, so its next try is at 60 s), when the app comes to the foreground (and at app start), and right after any request that succeeds. It stays flagged and counted as the server has it until a retry succeeds; then the flag clears as for a tap (phone == server). One 5xx flags it again at once (no 3 new tries). Tap-retry unchanged. No new copy. (store.tsx queueAutoRetry / autoRetryMs / anyOk; __tests__/autoRetry.test.tsx)
- 5xx path: an edit from another device leaves the flagged count stale until a retry (N4).
- [x] 5xx path: a stale `delete_failed` flag stays after editing a flagged row.
  Done: an edit (updateEntry -> editedState) takes the row's sync state from the store as it is NOW, never from the copy the edit sheet opened with (an automatic retry, a flagged delete or a server copy may have landed since): server version, server_counts, server_failed. An edit of a row whose delete is flagged or still queued replaces that delete: the row is live, delete_failed / unsynced_edit go, the delete op is replaced by the upsert, and it counts what the server has until the edit syncs; then phone == server. A row whose delete already went through stays deleted (nothing queued). Progress rows now show the kcal they count (countedNums) in every state. (__tests__/fiveXXPath.test.tsx)
- 5xx path: the Progress row says "Edit" where it should say retry.
- 5xx path: the streak dips while a delete is pending.

## Carried over (CEO-deferred)
- F3, F6, F-3, F-5.
- Above 5,000 roti, ask for a confirm.
- Lower-case chips and titles.
- A row left in_flight forever.
- Gram hint.
- Jest timeouts.
- Unit pluralising ("glasss").
- [x] Roti showing both count and piece chips. (CEO Oct 17: hide the count chip on dishes that also have a piece unit.)
  Done: in the dish table count and piece are the same thing for all 128 dishes that have both (equal kcal, protein, carbs, fat and grams at every amount), so they share ONE chip, labelled "piece" (Designer: singular, like katori / spoon / plate / gram; replaces abb0846's "pieces" chip). It is selected on a count row and tapping it keeps the row's unit, so a count row is never converted and nothing changes on the server. Where count is the only option, its chip reads "piece". Display only (unitChips in labels.ts). Tests: __tests__/pieceChip.test.tsx (roti sheet, count row edit + save kcal, count-only, unit sweep 0 mismatches); QA shot edit-sheet-units-roti.
- Tiny gram amounts give "refusing to save 0 kcal".
- The server accepts typed 0 kcal.
- On a flagged delete of an older-build row with a queued edit, fetch the server row.
- After closed-test-2: the 6 combo dishes (bread butter, chole bhature, rajma chawal, kadhi chawal, chole chawal, dal chawal).
