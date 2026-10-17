# Next build (after closed-test-2)

Branched from `closed-test-2` (app 72b6eb4, backend e461c87). Backend work goes on
`next-build` in calorie-tracker. Order is CEO's (Oct 17, 2026).

## Top
1. [x] Edge (a): phone counts 0 and server 220, but the row only says "not counted". Make the phone count and show the server's numbers.
   Done: a flagged row (5xx save or delete) the server has stored but whose numbers the phone never knew is fetched with GET /v1/entries/{id} and counted at the server's copy, still flagged. A failed GET leaves it "not counted" and it is asked again at the next sync / app start.
2. [x] Edit dropped when a delete is refused: an edit still queued at that point is lost with no message, and the row shows the phone's qty while counting the server's 220. Restore qty and unit from the server row, or re-queue the edit.
   Done (CEO, Oct 17: always restore, never re-send): a delete that replaced an unsynced edit (queued, or flagged 5xx) is marked; if the server refuses it, the server's copy is read (GET, or the 409's copy) and the row ALWAYS takes the server's qty, unit and numbers (shown == counted). The edit is never re-sent; the note after the reason says "Your change to 3 pieces wasn’t saved. Edit it again if you still want it." If the copy can't be read, the row counts the server's last known numbers, flagged, with the same note.

## rg10 notes (Tester)
- "Saved as 2 count" reads badly. Needs pieces wording.
- The note row uses Indian-style digit grouping, so 1,00,000 shows above 99,999.
- 5xx path: no automatic retry once the server is back.
- 5xx path: an edit from another device leaves the flagged count stale until a retry (N4).
- 5xx path: a stale `delete_failed` flag stays after editing a flagged row.
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
- Roti showing both count and piece chips.
- Tiny gram amounts give "refusing to save 0 kcal".
- The server accepts typed 0 kcal.
- On a flagged delete of an older-build row with a queued edit, fetch the server row.
- After closed-test-2: the 6 combo dishes (bread butter, chole bhature, rajma chawal, kadhi chawal, chole chawal, dal chawal).
