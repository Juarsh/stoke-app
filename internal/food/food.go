// Package food: Hinglish parsing, the fallback, and food_entries (editable
// chips with soft delete and updated_at for offline last-write-wins sync).
package food

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/akarsh/calorie-tracker/internal/httpx"
	"github.com/akarsh/calorie-tracker/internal/parser"
	"github.com/akarsh/calorie-tracker/internal/summary"
)

type Rebuilder interface {
	Rebuild(ctx context.Context, userID int64, day time.Time) (summary.Day, error)
}

type Service struct {
	// CompoundToAI: compound_name phrases go to the AI (true) or stay as
	// did_you_mean items to confirm with no AI call (false, default).
	CompoundToAI bool
	DB           *pgxpool.Pool
	Parser       *parser.Parser
	Fallback     Fallback
	Summary      Rebuilder
	// GlobalCap is the project-wide daily limit on AI calls (0 = no limit).
	GlobalCap atomic.Int64
	// Quota: per-user cap, reset zone and Google's daily-quota state.
	Quota *Quota
	// Live is the current dish table (swapped by admin imports).
	Live     *Live
	importMu sync.Mutex
	// Queue holds AI jobs and drains them at the per-minute cap.
	Queue *Queue
	// Versions holds every published dish table (nil = current only).
	Versions *Versions
}

// ---------- parse ----------

type Total struct {
	Kcal        float64 `json:"kcal"` // best guess
	KcalLow     float64 `json:"kcal_low"`
	KcalHigh    float64 `json:"kcal_high"`
	ProteinG    float64 `json:"protein_g"` // best guess
	ProteinLow  float64 `json:"protein_low"`
	ProteinHigh float64 `json:"protein_high"`
	CarbsG      float64 `json:"carbs_g"` // estimate
	FatG        float64 `json:"fat_g"`   // estimate
	// NeedsReview counts entries left out of these totals until confirmed.
	NeedsReview int `json:"needs_review,omitempty"`
}

type CustomItem struct {
	CustomName string `json:"custom_name"`
	NeedsInput bool   `json:"needs_input"`
}

type ParseResponse struct {
	Items             []parser.Item `json:"items"`
	Unmatched         []string      `json:"unmatched"`
	Total             Total         `json:"total"`
	UsedAI            bool          `json:"used_ai"`
	NeedsConfirmation bool          `json:"needs_confirmation"` // some item must be confirmed before saving
	Fallback          string        `json:"fallback"`           // none, used, not_configured, cap_reached, global_cap_reached, daily_limit, busy, error, gave_up
	// FallbackReason: why there is no AI answer, machine-readable: user_limit,
	// daily_limit, error, gave_up (ai_state failed); rate_limited, unavailable,
	// timeout only ever mean busy, still estimating (on the job poll as busy_reason).
	FallbackReason string `json:"fallback_reason,omitempty"`
	// AIResetsAt (with user_limit / daily_limit): when the caps reset (RFC 3339).
	AIResetsAt string `json:"ai_resets_at,omitempty"`
	// NextResetAt: when the daily AI caps (per user and project-wide) next
	// reset, RFC 3339 (midnight in AI_QUOTA_RESET_TZ: 12:30 PM IST in PDT,
	// 1:30 PM IST in PST). On every parse response and job poll, so the app's
	// own per-user count resets at the same instant.
	NextResetAt string `json:"next_reset_at,omitempty"`
	// UserDailyLimit (with user_limit): AI_USER_DAILY_CAP.
	UserDailyLimit int64        `json:"user_daily_limit,omitempty"`
	CustomItems    []CustomItem `json:"custom_items"`
	Message        string       `json:"message,omitempty"`
	Slot           string       `json:"slot"`
	// Status is "done", or "pending" (HTTP 202) with JobID to poll at
	// GET /v1/parse/jobs/{job_id}.
	Status string `json:"status"`
	JobID  string `json:"job_id,omitempty"`
	// Answer says who answered: table, ai, or generic (rule-based guess, all to confirm).
	Answer string `json:"answer,omitempty"`
	// AIState is what the app reads for an AI-bound meal: "estimating"
	// (pending job, keep the row in Estimating), "failed" (no AI answer is
	// coming: daily_limit / user_limit / error; the open spans are in
	// failed_spans with no kcal, the user types the calories) or "answered"
	// (AI or cache items). Empty when the AI was not involved.
	AIState     string `json:"ai_state,omitempty"`
	FailedSpans []Span `json:"failed_spans,omitempty"`
	// Entries saved with this job's id (job results only).
	Entries []JobEntry `json:"entries,omitempty"`
}

func totals(items []parser.Item) Total {
	k, p := parser.Totals(items)
	t := Total{Kcal: k.Best, KcalLow: k.Low, KcalHigh: k.High, ProteinG: p.Best, ProteinLow: p.Low, ProteinHigh: p.High}
	for _, it := range items {
		t.CarbsG += it.CarbsG
		t.FatG += it.FatG
	}
	t.CarbsG, t.FatG = math.Round(t.CarbsG*10)/10, math.Round(t.FatG*10)/10
	return t
}

// Parse applies the strict rule. The table answers alone only when every
// span is a clean exact/alias match with a stated count or unit (or a
// remembered food). Otherwise the WHOLE meal goes to the AI: a cache hit
// answers at once; a miss is queued and Parse returns a pending job.
func (s *Service) Parse(ctx context.Context, userID int64, text string, useAI bool) (ParseResponse, *Job) {
	res := s.parser().Parse(text)
	slot := httpx.SlotFor(httpx.Now())

	// remembered readings stand in for their spans
	learned := s.readings(ctx, userID)
	// a remembered whole-meal text wins before anything else (no AI call)
	whole := learnedItems(learned[Normalize(text)], text)
	if whole == nil {
		if cnt, key := splitCount(text); cnt != 1 && len(learned[key]) > 0 {
			for _, it := range learnedItems(learned[key], text) {
				whole = append(whole, scaleItem(it, cnt))
			}
		}
	}
	if whole != nil {
		s.setSpans(whole, text)
		out := ParseResponse{Items: whole, Fallback: "none", Answer: "table", CustomItems: []CustomItem{}, Slot: slot, Status: "done"}
		return finishResp(out), nil
	}
	var items []parser.Item
	rest := parser.Result{}
	done := map[string]bool{}
	for _, it := range res.Items {
		key := Normalize(it.Matched)
		if rs, ok := learned[key]; ok {
			if !done[key] {
				items = append(items, learnedItems(rs, it.Matched)...)
				done[key] = true
			}
			continue
		}
		rest.Items = append(rest.Items, it)
	}
	for _, u := range res.Unmatched {
		if !foodLike(u) {
			continue
		}
		cnt, key := splitCount(u)
		if rs, ok := learned[key]; ok {
			for _, li := range learnedItems(rs, u) {
				items = append(items, scaleItem(li, cnt))
			}
			continue
		}
		rest.Unmatched = append(rest.Unmatched, u)
	}
	if len(rest.Items) == 0 && len(rest.Unmatched) == 0 && len(items) > 0 || len(rest.Items) > 0 && s.parser().TableOnly(rest) {
		s.setSpans(items, text)
		out := ParseResponse{Items: append(items, rest.Items...), Unmatched: []string{}, Fallback: "none", Answer: "table",
			CustomItems: []CustomItem{}, Slot: slot, Status: "done"}
		return finishResp(out), nil
	}

	// claimed = confident table items (and remembered foods); the AI only
	// answers for the rest of the text
	s.setSpans(items, text)
	claimed := append([]parser.Item(nil), items...)
	for _, it := range res.Items {
		if _, isLearned := done[Normalize(it.Matched)]; isLearned {
			continue
		}
		if c, ok := s.parser().Claim(it); ok {
			claimed = append(claimed, c)
		}
	}
	// Parser items that aren't confident (fuzzy "rotti", "sambar" split
	// from a list, a unit_mismatch count) still cover their words: they stay
	// as did_you_mean items to confirm, and their words never reach the AI.
	// Generic placeholders and a table word glued to unknown words
	// (leftover_nearby, "kuttu cheela") don't cover: that phrase goes to the
	// AI as one span.
	for _, it := range res.Items {
		if _, isLearned := done[Normalize(it.Matched)]; isLearned {
			continue
		}
		if _, ok := s.parser().Claim(it); ok || it.Source == parser.SourceGeneric || hasFlag(it.Flags, "leftover_nearby") || (s.CompoundToAI && hasFlag(it.Flags, "compound_name")) {
			continue
		}
		it.NeedsConfirmation = true
		if it.Source == parser.SourceTable {
			it.Source = parser.SourceDidYouMean
		}
		claimed = append(claimed, it)
	}
	spans := unclaimed(text, claimed, s.parser().Noise)
	unknownWords := map[string]bool{}
	for _, u := range rest.Unmatched {
		for _, w := range strings.Fields(Normalize(u)) {
			if !isNumber(w) {
				unknownWords[w] = true
			}
		}
	}
	// a remembered food can also cover an unclaimed span
	var open []Span
	for _, sp := range spans {
		if rs, ok := learned[Normalize(sp.Text)]; ok {
			li := learnedItems(rs, sp.Text)
			for i := range li {
				li[i].SpanStart, li[i].SpanEnd = sp.Start, sp.End
			}
			claimed = append(claimed, li...)
			continue
		}
		// words the parser already used (counts, units, "ek", "half",
		// "2 egg ka" folded into an omelette) are not unknown: a span is open
		// only if it holds a word nothing used, or overlaps an item that
		// doesn't cover its words (generic, leftover_nearby)
		if !foodLike(sp.Text) || !hasUnknown(sp, unknownWords, res.Items, claimed) {
			continue
		}
		open = append(open, sp)
	}
	sortBySpan(claimed)
	// no unclaimed span: never call the AI
	if len(open) == 0 && len(claimed) > 0 {
		out := ParseResponse{Items: claimed, Unmatched: []string{}, Fallback: "none", Answer: "table",
			CustomItems: []CustomItem{}, Slot: slot, Status: "done"}
		return finishResp(out), nil
	}
	hint := append([]parser.Item(nil), res.Items...)
	key := spanKey(text, claimed)
	if useAI {
		if cached, ok := s.cacheGet(ctx, key); ok {
			return s.aiResponse(claimed, cached, hint, "cache", slot), nil
		}
	}
	// without an AI answer, the claimed items still stand; only the open
	// spans become placeholders to confirm
	gen := s.fallbackResponse(claimed, open, res, slot)
	generic := func(fb, msg string) (ParseResponse, *Job) {
		out := gen
		out.Fallback, out.Message = fb, msg
		return finishResp(out), nil
	}
	if !useAI {
		return generic("none", "")
	}
	if _, ok := s.Fallback.(NoFallback); ok || s.Fallback == nil {
		return generic("not_configured", "")
	}
	// No AI answer (cap hit): a table dish glued to unknown words
	// ("roti zorbali") stays resolved, to confirm; only the unknown words
	// need the user's input.
	failClaimed := append([]parser.Item(nil), claimed...)
	for _, it := range res.Items {
		if it.DishID == "" || it.Source == parser.SourceGeneric || !hasFlag(it.Flags, "leftover_nearby") {
			continue
		}
		if _, isLearned := done[Normalize(it.Matched)]; isLearned {
			continue
		}
		it.NeedsConfirmation, it.OneTapOK = true, false
		if it.Source == parser.SourceTable {
			it.Source = parser.SourceDidYouMean
		}
		failClaimed = append(failClaimed, it)
	}
	var failOpen []Span
	if len(failClaimed) == len(claimed) {
		failOpen = open
	} else {
		for _, sp := range unclaimed(text, failClaimed, s.parser().Noise) {
			if foodLike(sp.Text) && hasUnknown(sp, unknownWords, nil, failClaimed) {
				failOpen = append(failOpen, sp)
			}
		}
		sortBySpan(failClaimed)
	}
	failed := func(fb, reason string) (ParseResponse, *Job) {
		return s.failedResponse(failClaimed, failOpen, slot, fb, reason), nil
	}
	if ex, _ := s.Quota.Exhausted(httpx.Now()); ex {
		// Google's daily quota is used up: no call (and no retry) until its reset
		return failed("daily_limit", "daily_limit")
	}
	if st := s.reserveAI(ctx, userID); st != "" {
		switch st {
		case "cap_reached": // this user's AI_USER_DAILY_CAP
			return failed(st, "user_limit")
		case "global_cap_reached": // the project's AI_DAILY_CAP
			return failed(st, "daily_limit")
		}
		return failed(st, "error")
	}
	job, ok := s.Queue.Add(userID, text, key, hint, gen, slot, claimed, open, FailSplit{failClaimed, failOpen})
	if !ok {
		// our own queue is full (AI_QUEUE_MAX): no job to wait on, so this
		// ends as error; the reserved call is given back
		s.releaseAI(ctx, userID)
		return failed("busy", "error")
	}
	return ParseResponse{Items: []parser.Item{}, Unmatched: []string{}, CustomItems: []CustomItem{}, Fallback: "queued",
		Slot: slot, Status: "pending", JobID: job.ID, NeedsConfirmation: true, AIState: "estimating"}, job
}

// setSpans gives items built outside the parser (AI answers, remembered
// foods) a span in the user's text: their own words if found there,
// otherwise the whole text.
func (s *Service) setSpans(items []parser.Item, text string) {
	for i := range items {
		it := &items[i]
		if it.SpanEnd > 0 {
			continue
		}
		var ok bool
		for _, w := range []string{it.AIName, it.Name, it.DishID, it.Matched} {
			if w == "" || w == text {
				continue
			}
			if it.SpanStart, it.SpanEnd, ok = s.parser().Locate(text, w); ok {
				break
			}
		}
		if !ok {
			it.SpanStart, it.SpanEnd, _ = s.parser().Locate(text, text)
		}
	}
}

func finishResp(out ParseResponse) ParseResponse {
	if out.Unmatched == nil {
		out.Unmatched = []string{}
	}
	parser.SetOneTap(out.Items)
	out.Total = totals(out.Items)
	out.NeedsConfirmation = false
	for _, it := range out.Items {
		out.NeedsConfirmation = out.NeedsConfirmation || it.NeedsConfirmation
	}
	return out
}

// spanHasUnknown: the span holds an unmatched word outside the given items.
func spanHasUnknown(sp Span, items []parser.Item, unmatched []string) bool {
	for _, u := range unmatched {
		for _, w := range strings.Fields(Normalize(u)) {
			if isNumber(w) {
				continue
			}
			if strings.Contains(" "+Normalize(sp.Text)+" ", " "+w+" ") {
				return true
			}
		}
	}
	return false
}

func isNumber(w string) bool {
	_, err := strconv.ParseFloat(w, 64)
	return err == nil
}

// hasUnknown: the span holds a word nothing in the parse used, or overlaps a
// parser item that was not kept as covering its words.
func hasUnknown(sp Span, unknown map[string]bool, items, claimed []parser.Item) bool {
	for _, w := range strings.Fields(Normalize(sp.Text)) {
		if unknown[w] {
			return true
		}
	}
	for _, it := range items {
		if !overlaps(sp.Start, sp.End, it.SpanStart, it.SpanEnd) {
			continue
		}
		kept := false
		for _, c := range claimed {
			kept = kept || (c.SpanStart == it.SpanStart && c.SpanEnd == it.SpanEnd)
		}
		if !kept {
			return true
		}
	}
	return false
}

// fallbackResponse: the claimed items as they are, plus a placeholder to
// confirm for each unclaimed span (used when no AI answer is available).
func (s *Service) fallbackResponse(claimed []parser.Item, open []Span, res parser.Result, slot string) ParseResponse {
	out := ParseResponse{Unmatched: []string{}, CustomItems: []CustomItem{}, Slot: slot, Status: "done", Answer: "generic"}
	out.Items = append(out.Items, claimed...)
	for _, sp := range open {
		// a compound phrase with no AI answer: show the table's reading of
		// its words to confirm, not one blind placeholder
		var parts []parser.Item
		for _, it := range res.Items {
			if hasFlag(it.Flags, "compound_name") && it.SpanStart >= sp.Start && it.SpanEnd <= sp.End {
				it.NeedsConfirmation = true
				if it.Source == parser.SourceTable {
					it.Source = parser.SourceDidYouMean
				}
				parts = append(parts, it)
			}
		}
		if len(parts) > 0 && !spanHasUnknown(sp, parts, res.Unmatched) {
			out.Items = append(out.Items, parts...)
			continue
		}
		cnt, key := splitCount(sp.Text)
		it := scaleItem(s.parser().Unknown(key), cnt)
		it.SpanStart, it.SpanEnd = sp.Start, sp.End
		for _, h := range res.Items { // a known dish glued to these words
			if overlaps(sp.Start, sp.End, h.SpanStart, h.SpanEnd) && hasFlag(h.Flags, "leftover_nearby") {
				it.Flags = appendFlag(it.Flags, "leftover_nearby")
			}
		}
		out.Items = append(out.Items, it)
		out.Unmatched = append(out.Unmatched, sp.Text)
		out.CustomItems = append(out.CustomItems, CustomItem{CustomName: key, NeedsInput: true})
	}
	sortBySpan(out.Items)
	return out
}

// genericResponse: the rule-based parse with every item to confirm, and a
// placeholder card per unknown span (used when no AI answer is available).
func (s *Service) genericResponse(res parser.Result, slot string) ParseResponse {
	out := ParseResponse{Unmatched: res.Unmatched, CustomItems: []CustomItem{}, Slot: slot, Status: "done", Answer: "generic"}
	for _, it := range res.Items {
		it.NeedsConfirmation = true
		if it.Source == parser.SourceTable {
			it.Source = parser.SourceDidYouMean
		}
		out.Items = append(out.Items, it)
	}
	for _, u := range res.Unmatched {
		if !foodLike(u) {
			continue
		}
		cnt, key := splitCount(u)
		out.Items = append(out.Items, scaleItem(s.parser().Unknown(key), cnt))
		out.CustomItems = append(out.CustomItems, CustomItem{CustomName: key, NeedsInput: true})
	}
	return out
}

// aiResponse combines the claimed table items with the placed AI items.
// AI items keep the user's own words as matched_text (their span); the
// AI's dish name is in ai_name.
func (s *Service) aiResponse(claimed, ai, hint []parser.Item, fb, slot string) ParseResponse {
	out := ParseResponse{Unmatched: []string{}, CustomItems: []CustomItem{}, Slot: slot, Status: "done", Answer: "ai", Fallback: fb, UsedAI: true, AIState: "answered"}
	out.Items = append(out.Items, claimed...)
	for _, it := range ai {
		if it.Source != parser.SourceDidYouMean {
			it.Source = parser.SourceAI
		}
		it.AIEstimate, it.DataSource = true, "ai"
		it.NeedsConfirmation = true
		it.SourceNote = "AI estimate (Gemini) - confirm before saving"
		for _, h := range hint { // the AI read a phrase that glued a known dish to unknown words
			if overlaps(it.SpanStart, it.SpanEnd, h.SpanStart, h.SpanEnd) && hasFlag(h.Flags, "leftover_nearby") {
				it.Flags = appendFlag(it.Flags, "leftover_nearby")
			}
		}
		out.Items = append(out.Items, it)
	}
	sortBySpan(out.Items)
	return finishResp(out)
}

// runJob is the queue worker's AI call for one meal. requeue=true: Gemini
// was still busy (rate_limited / unavailable / timeout) after its retries;
// the job stays pending (estimating) and goes back into the queue. The queue
// ends it as gave_up when its window runs out.
//
// Cap counting: the meal reserved one unit of AI_USER_DAILY_CAP /
// AI_DAILY_CAP when it was queued (that covers the first attempt, even if
// Gemini answered 429). AI_USER_DAILY_CAP counts once per meal (job): later
// attempts never charge it. Each later attempt that fires and reaches Gemini
// (any HTTP response but 429, or no response / timeout) is charged one more
// unit of AI_DAILY_CAP only. A 429 means Google rejected the request before running it, so it is
// not charged. An attempt that never sends (no limiter slot, deadline)
// charges nothing. A later attempt is not made when AI_DAILY_CAP is already
// used up (the meal ends as daily_limit).
func (s *Service) runJob(ctx context.Context, j *Job) (ParseResponse, bool) {
	fc, fs := j.failSplit()
	if j.Requeues > 0 && s.globalCapFull(ctx) {
		log.Printf("ai failed daily_limit: job=%s detail=%q", j.ID, "AI_DAILY_CAP used up before a requeued attempt")
		return s.failedResponse(fc, fs, j.Slot, "global_cap_reached", "daily_limit"), false
	}
	sc := &sendCount{}
	items, err := s.Fallback.EstimateMeal(withSendCount(ctx, sc), j.Text, j.Spans, j.Hint)
	if j.Requeues > 0 && sc.n.Load() > 0 {
		s.chargeAI(ctx, j.UserID) // one more unit for this later attempt
	}
	outcome := "used"
	defer func() { s.logAICall(ctx, j, int(sc.n.Load()), outcome) }()
	for i := range items {
		if items[i].AIName == "" {
			items[i].AIName = items[i].Name
		}
	}
	placed := placeAI(j.Text, items, j.Spans, j.Claimed, s.parser().Locate)
	if err != nil || !plausible(items) || len(placed) == 0 {
		reason := aiFailReason(err, items)
		var ae *AIError
		if errors.As(err, &ae) && ae.DailyQuota {
			s.Quota.PersistExhausted(ctx, s.DB, httpx.Now())
			log.Printf("ai failed daily_limit: job=%s detail=%q", j.ID, aiFailDetail(err))
			outcome = "daily_limit"
			return s.failedResponse(fc, fs, j.Slot, "daily_limit", "daily_limit"), false
		}
		if reason == "rate_limited" || reason == "unavailable" || reason == "timeout" {
			log.Printf("ai busy, requeue: job=%s reason=%s requeues=%d detail=%q", j.ID, reason, j.Requeues, aiFailDetail(err))
			outcome = "requeue:" + reason
			return ParseResponse{FallbackReason: reason}, true
		}
		log.Printf("ai failed error: job=%s reason=%s detail=%q", j.ID, reason, aiFailDetail(err))
		outcome = "error:" + reason
		return s.failedResponse(fc, fs, j.Slot, "error", "error"), false
	}
	s.cachePut(ctx, j.Key, placed) // raw AI answer (placed), never user corrections
	return s.aiResponse(j.Claimed, placed, j.Hint, "used", j.Slot), false
}

// failedResponse: no AI answer is coming (daily_limit, user_limit, error, gave_up).
// The confident table items stand; each open span is listed in
// failed_spans / unmatched / custom_items with NO kcal: the user types it.
func (s *Service) failedResponse(claimed []parser.Item, open []Span, slot, fb, reason string) ParseResponse {
	out := ParseResponse{Items: append([]parser.Item{}, claimed...), Unmatched: []string{}, CustomItems: []CustomItem{},
		Slot: slot, Status: "done", Answer: "none", Fallback: fb, FallbackReason: reason, AIState: "failed",
		FailedSpans: append([]Span{}, open...)}
	for _, sp := range open {
		_, key := splitCount(sp.Text)
		out.Unmatched = append(out.Unmatched, sp.Text)
		out.CustomItems = append(out.CustomItems, CustomItem{CustomName: key, NeedsInput: true})
	}
	out.NextResetAt = s.nextResetAt()
	switch reason {
	case "user_limit":
		out.AIResetsAt = s.Quota.NextReset(httpx.Now()).Format(time.RFC3339)
		out.UserDailyLimit = s.userCap()
		out.Message = fmt.Sprintf("You've used today's %d AI estimates. Add the calories yourself.", out.UserDailyLimit)
	case "daily_limit":
		out.AIResetsAt = s.Quota.NextReset(httpx.Now()).Format(time.RFC3339)
		out.Message = "AI estimates are used up for now. Add the calories yourself."
	default:
		out.Message = "Couldn't estimate this. Add the calories yourself."
	}
	sortBySpan(out.Items)
	out = finishResp(out)
	if len(open) > 0 {
		out.NeedsConfirmation = true // the open spans still need the user's kcal
	}
	return out
}

// aiFailReason is the fallback_reason for a failed AI job: never the key,
// the prompt or the answer text.
func aiFailReason(err error, items []parser.Item) string {
	var ae *AIError
	switch {
	case errors.As(err, &ae):
		return ae.Code()
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	}
	return "error" // also an implausible or unplaceable answer
}

// aiFailDetail is the log detail: never the key, prompt or answer.
func aiFailDetail(err error) string {
	var ae *AIError
	if errors.As(err, &ae) {
		return ae.Reason()
	}
	if err == nil {
		return "answer rejected (implausible or not placed)"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	return "non-http error"
}

// dailyLimit marks a response whose project-wide daily quota (AI_DAILY_CAP or Google's) is used up.
func (s *Service) dailyLimit(out ParseResponse, job *Job) (ParseResponse, *Job) {
	out.FallbackReason, out.AIResetsAt = "daily_limit", s.Quota.NextReset(httpx.Now()).Format(time.RFC3339)
	out.NextResetAt = out.AIResetsAt
	return out, job
}

// nextResetAt: the next daily cap reset (RFC 3339), see ParseResponse.NextResetAt.
func (s *Service) nextResetAt() string {
	return s.Quota.NextReset(httpx.Now()).Format(time.RFC3339)
}

// userCap: AI_USER_DAILY_CAP (0 = no per-user limit).
func (s *Service) userCap() int64 {
	if s.Quota == nil {
		return DefaultUserDailyCap
	}
	if c := s.Quota.UserCap.Load(); c > 0 {
		return c
	}
	return 1 << 40
}

// reserveAI counts one call against the per-user and project-wide daily
// caps; it returns a fallback status when either is reached.
func (s *Service) reserveAI(ctx context.Context, userID int64) string {
	today := s.Quota.Day(httpx.Now())
	var calls int
	err := s.DB.QueryRow(ctx, `INSERT INTO ai_usage(user_id,local_date,calls) VALUES ($1,$2,1)
		ON CONFLICT (user_id,local_date) DO UPDATE SET calls=ai_usage.calls+1 WHERE ai_usage.calls < $3
		RETURNING calls`, userID, today, s.userCap()).Scan(&calls)
	if errors.Is(err, pgx.ErrNoRows) {
		return "cap_reached"
	}
	if err != nil {
		return "error"
	}
	gc := s.GlobalCap.Load() // 0 = unlimited, but always counted
	err = s.DB.QueryRow(ctx, `INSERT INTO ai_global_usage(local_date,calls) VALUES ($1,1)
		ON CONFLICT (local_date) DO UPDATE SET calls=ai_global_usage.calls+1 WHERE $2::bigint=0 OR ai_global_usage.calls < $2
		RETURNING calls`, today, gc).Scan(&calls)
	if errors.Is(err, pgx.ErrNoRows) {
		return "global_cap_reached"
	}
	if err != nil {
		return "error"
	}
	return ""
}

// foodLike: any span with a letter (pure numbers are noise).
func foodLike(s string) bool {
	for _, r := range s {
		if unicode.IsLetter(r) {
			return true
		}
	}
	return false
}

// Normalize is the key for the AI cache and remembered readings:
// lower case, single spaces, no punctuation.
func Normalize(s string) string {
	s = strings.ToLower(s)
	s = strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '.' || unicode.Is(unicode.Mn, r) || unicode.Is(unicode.Mc, r) {
			return r
		}
		return ' '
	}, s)
	return strings.Join(strings.Fields(s), " ")
}

// splitCount separates a leading count: "2 pav" -> 2, "pav".
func splitCount(span string) (float64, string) {
	n := Normalize(span)
	f := strings.Fields(n)
	if len(f) > 1 {
		if v, err := strconv.ParseFloat(f[0], 64); err == nil && v > 0 && v <= 50 {
			return v, strings.Join(f[1:], " ")
		}
	}
	return 1, n
}

func scaleItem(it parser.Item, k float64) parser.Item {
	if k == 1 || k <= 0 {
		return it
	}
	r := func(x float64, d float64) float64 { return math.Round(x*d) / d }
	it.Quantity = r(it.Quantity*k, 100)
	it.Grams = r(it.Grams*k, 1)
	it.Kcal = parser.Range{Low: r(it.Kcal.Low*k, 1), Best: r(it.Kcal.Best*k, 1), High: r(it.Kcal.High*k, 1)}
	it.Protein = parser.Range{Low: r(it.Protein.Low*k, 10), Best: r(it.Protein.Best*k, 10), High: r(it.Protein.High*k, 10)}
	it.CarbsG, it.FatG = r(it.CarbsG*k, 10), r(it.FatG*k, 10)
	return it
}

func (s *Service) cacheGet(ctx context.Context, key string) ([]parser.Item, bool) {
	var raw []byte
	err := s.DB.QueryRow(ctx, `UPDATE ai_cache SET hits=hits+1, last_hit_at=now() WHERE norm_text=$1 RETURNING items`, key).Scan(&raw)
	if err != nil {
		return nil, false
	}
	var items []parser.Item
	if json.Unmarshal(raw, &items) != nil || len(items) == 0 {
		return nil, false
	}
	return items, true
}

func (s *Service) cachePut(ctx context.Context, key string, items []parser.Item) {
	b, err := json.Marshal(items)
	if err != nil || len(items) == 0 || s.DB == nil {
		return
	}
	_, _ = s.DB.Exec(ctx, `INSERT INTO ai_cache(norm_text,items) VALUES ($1,$2) ON CONFLICT (norm_text) DO NOTHING`, key, b)
}

// ---------- entries ----------

type Entry struct {
	ID          int64   `json:"id"`
	LocalDate   string  `json:"local_date"`
	Slot        string  `json:"slot"`
	RawText     string  `json:"raw_text"`
	DishID      *string `json:"dish_id"`
	Name        string  `json:"name"`
	CustomName  string  `json:"custom_name"`
	Qty         float64 `json:"qty"`
	Unit        string  `json:"unit"`
	OilLevel    string  `json:"oil_level"`
	KcalBest    float64 `json:"kcal_best"`
	KcalLow     float64 `json:"kcal_low"`
	KcalHigh    float64 `json:"kcal_high"`
	ProteinBest float64 `json:"protein_best"`
	ProteinLow  float64 `json:"protein_low"`
	ProteinHigh float64 `json:"protein_high"`
	Source      string  `json:"source"`
	Confirmed   bool    `json:"confirmed"`
	ClientID    *string `json:"client_id"`
	TableVer    *int    `json:"dish_table_version"`
	CarbsG      float64 `json:"carbs_g"`
	FatG        float64 `json:"fat_g"`
	Span        string  `json:"span"`
	// State: confirmed (counts in totals) or needs_review (counts for the
	// streak only, until confirmed with PATCH {"state":"confirmed"}).
	State        string    `json:"state"`
	SpanPart     int       `json:"span_part"`
	ParseJobID   *string   `json:"parse_job_id"`
	ClientItemID *string   `json:"client_item_id"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
	DeletedAt    *string   `json:"deleted_at"`
	// Version: the server's row version (1 on insert, +1 on every write). PATCH
	// sends back the version the client last saw (409 version_conflict if stale).
	Version int `json:"version"`
}

// ItemIn is one chip the client confirms. Either dish_id (values recomputed
// from our table) or custom_name with the user's/AI's numbers.
type ItemIn struct {
	DishID      string   `json:"dish_id"`
	Qty         float64  `json:"qty"`
	Unit        string   `json:"unit"`
	OilLevel    string   `json:"oil_level"`
	CustomName  string   `json:"custom_name"`
	Kcal        *float64 `json:"kcal"`
	ProteinG    *float64 `json:"protein_g"`
	ProteinAlt  *float64 `json:"protein"` // accepted alias for protein_g
	KcalLow     *float64 `json:"kcal_low"`
	KcalHigh    *float64 `json:"kcal_high"`
	ProteinLow  *float64 `json:"protein_low"`
	ProteinHigh *float64 `json:"protein_high"`
	// Source is required: table | did_you_mean | generic | ai_estimate (from
	// /v1/parse) or custom (numbers typed by the user).
	Source    string `json:"source"`
	Confirmed bool   `json:"confirmed"` // required when the item needs confirmation
	// Span is the parse item's matched_text. When confirmed, the reading is
	// remembered for this user and the next parse returns it learned=true.
	Span string `json:"span,omitempty"`
	// State "needs_review" saves the item unconfirmed: no confirmation or
	// number checks, excluded from totals, counts toward the streak.
	State string `json:"state,omitempty"`
	// ParseJobID (alias job_id) / ClientItemID tie the entry to a parse job
	// and the app's item, so a late AI answer can be matched to it.
	ParseJobID   string `json:"parse_job_id,omitempty"`
	JobID        string `json:"job_id,omitempty"`
	ClientItemID string `json:"client_item_id,omitempty"`
	// VariantDishID: the variant the user picked from variant_options. Required
	// (and must equal dish_id) when the text named only an ambiguous base
	// dish ("biryani"); otherwise the save is refused with variant_required.
	VariantDishID string `json:"variant_dish_id,omitempty"`
	// ClientID makes saves idempotent: a repeat returns the stored entry.
	ClientID string `json:"client_id"`
	// DishTableVersion is required when a table item carries the client's own
	// numbers; they are checked against that version, never silently replaced.
	DishTableVersion *int     `json:"dish_table_version"`
	CarbsG           *float64 `json:"carbs_g"`
	FatG             *float64 `json:"fat_g"`
	// KcalPerUnit (AI estimates): kcal for one qty of unit; kcal must equal
	// kcal_per_unit x qty, otherwise the entry is saved corrected.
	KcalPerUnit *float64 `json:"kcal_per_unit"`
}

// Tolerances for checking a client's numbers against the table.
const (
	kcalTolAbs, kcalTolRel = 2.0, 0.02
	protTolAbs, protTolRel = 0.5, 0.03
)

func within(got, want, abs, rel float64) bool {
	return math.Abs(got-want) <= math.Max(abs, rel*math.Abs(want))
}

var slots = map[string]bool{"breakfast": true, "lunch": true, "snacks": true, "dinner": true}

func f(p *float64, d float64) float64 {
	if p == nil {
		return d
	}
	return *p
}

var saveSources = map[string]bool{"table": true, "did_you_mean": true, "generic": true, "ai_estimate": true, "custom": true, "manual": true}

// resolve validates one item and turns it into column values.
//   - source is required
//   - anything that needs confirmation (not a confident table match, or a
//     table match flagged by the sanity check) must come with confirmed=true
//   - 0 kcal is only saved when the user typed it (custom/manual), or for a
//     table row whose own value is 0 (water)
func (s *Service) resolve(ctx context.Context, in ItemIn) (Entry, int, error) {
	var e Entry
	bad := func(code int, msg string) (Entry, int, error) { return e, code, errors.New(msg) }
	if in.ProteinG == nil {
		in.ProteinG = in.ProteinAlt
	}
	if !saveSources[in.Source] {
		return bad(400, "source is required: table, did_you_mean, generic, ai_estimate or custom")
	}
	if len(in.ClientID) > 100 {
		return bad(400, "client_id too long")
	}
	if in.Qty == 0 {
		in.Qty = 1
	}
	cid := func() *string {
		if in.ClientID == "" {
			return nil
		}
		c := in.ClientID
		return &c
	}()
	if in.State != "" && in.State != "confirmed" && in.State != "needs_review" { // corrected is server-set only
		return bad(400, "state must be confirmed or needs_review")
	}
	if in.KcalPerUnit != nil && in.Source != "ai_estimate" {
		return bad(400, "kcal_per_unit is only for ai_estimate items")
	}
	if in.State == "needs_review" {
		return s.draft(in, cid)
	}
	// a table dish in a unit it doesn't come in (poha plate sent as
	// "piece"): never confirmed at the client's numbers; saved needs_review
	// with the server's numbers for its default unit, flagged unit_mismatch
	if in.DishID != "" && in.Source != "ai_estimate" && in.Source != "custom" && in.Source != "manual" &&
		in.Unit != "" && !s.parser().ValidUnit(in.DishID, in.Unit) {
		if _, ok := s.parser().Dish(in.DishID); ok {
			d := in
			d.Unit, d.Kcal, d.KcalLow, d.KcalHigh, d.ProteinG, d.ProteinLow, d.ProteinHigh, d.CarbsG, d.FatG = "", nil, nil, nil, nil, nil, nil, nil, nil
			return s.draft(d, cid)
		}
	}
	userTyped := in.Source == "custom" || in.Source == "manual"
	if in.DishID != "" && in.Source != "ai_estimate" && !userTyped {
		// validate against the table version the client used (any published one)
		tp := s.parser()
		ver := tp.TableVersion()
		if in.DishTableVersion != nil && s.Versions != nil {
			p, err := s.Versions.Parser(ctx, *in.DishTableVersion)
			if errors.Is(err, ErrUnknownVersion) {
				return e, 409, &unknownVersion{got: *in.DishTableVersion, server: s.Versions.Current}
			}
			if err != nil {
				return bad(500, "db")
			}
			tp, ver = p, *in.DishTableVersion
		} else if in.DishTableVersion != nil && *in.DishTableVersion != ver {
			return e, 409, &unknownVersion{got: *in.DishTableVersion, server: ver}
		}
		it, err := tp.Recompute(in.DishID, in.Qty, in.Unit, in.OilLevel)
		if err != nil {
			return bad(400, err.Error())
		}
		needs := in.Source != "table" || it.NeedsConfirmation
		if needs && !in.Confirmed {
			return bad(400, "item needs confirmation: send confirmed=true after the user checks it")
		}
		id := it.DishID
		src := in.Source
		if it.Source == parser.SourceGeneric {
			src = "generic"
		}
		e = Entry{DishID: &id, Name: it.Name, Qty: it.Quantity, Unit: it.Unit, OilLevel: it.OilLevel,
			KcalBest: it.Kcal.Best, KcalLow: it.Kcal.Low, KcalHigh: it.Kcal.High,
			ProteinBest: it.Protein.Best, ProteinLow: it.Protein.Low, ProteinHigh: it.Protein.High,
			CarbsG: it.CarbsG, FatG: it.FatG, Source: src, Confirmed: true, ClientID: cid, TableVer: &ver}
		if in.Kcal != nil || in.ProteinG != nil {
			// the client's confirmed numbers: check them, store them, never recalculate silently
			if in.DishTableVersion == nil {
				return bad(400, "dish_table_version is required when sending numbers for a table item")
			}
			// numbers that don't match the dish in this unit (a plate's kcal
			// sent with unit piece) are never saved: the server's own numbers
			// are stored, state "corrected"
			if (in.Kcal != nil && !within(*in.Kcal, it.Kcal.Best, kcalTolAbs, kcalTolRel)) ||
				(in.ProteinG != nil && !within(*in.ProteinG, it.Protein.Best, protTolAbs, protTolRel)) {
				e.State = "corrected"
				return e, 0, nil
			}
			e.KcalBest = f(in.Kcal, e.KcalBest)
			e.ProteinBest = f(in.ProteinG, e.ProteinBest)
			e.KcalLow, e.KcalHigh = f(in.KcalLow, e.KcalLow), f(in.KcalHigh, e.KcalHigh)
			e.ProteinLow, e.ProteinHigh = f(in.ProteinLow, e.ProteinLow), f(in.ProteinHigh, e.ProteinHigh)
			if e.KcalLow > e.KcalBest || e.KcalHigh < e.KcalBest || e.ProteinLow > e.ProteinBest || e.ProteinHigh < e.ProteinBest {
				return bad(422, "ranges must contain the best guess")
			}
		}
		e.CarbsG, e.FatG = f(in.CarbsG, e.CarbsG), f(in.FatG, e.FatG)
		if e.KcalBest <= 0 {
			if d, _ := tp.Dish(in.DishID); d.Kcal != 0 {
				return bad(400, "refusing to save 0 kcal")
			}
		}
		return e, 0, nil
	}
	if !userTyped && !in.Confirmed {
		return bad(400, "item needs confirmation: send confirmed=true after the user checks it")
	}
	name := strings.TrimSpace(in.CustomName)
	if name == "" && in.DishID != "" {
		if d, ok := s.parser().Dish(in.DishID); ok {
			name = d.Name
		}
	}
	if name == "" || len(name) > 120 {
		return bad(400, "each item needs dish_id or custom_name")
	}
	state := ""
	if in.KcalPerUnit != nil {
		if in.Source != "ai_estimate" {
			return bad(400, "kcal_per_unit is only for ai_estimate items")
		}
		if *in.KcalPerUnit <= 0 || *in.KcalPerUnit > 3000 {
			return bad(400, "kcal_per_unit must be > 0 and <= 3000")
		}
		want := math.Round(*in.KcalPerUnit * in.Qty)
		if in.Kcal == nil {
			in.Kcal = &want
		} else if !within(*in.Kcal, want, kcalTolAbs, kcalTolRel) {
			in.Kcal, state = &want, "corrected" // kcal doesn't match qty x kcal_per_unit
			in.KcalLow, in.KcalHigh = nil, nil
		}
	}
	if in.Kcal == nil || *in.Kcal < 0 || *in.Kcal > 5000 {
		return bad(400, "this item needs kcal (0-5000)")
	}
	if *in.Kcal == 0 && !userTyped {
		return bad(400, "refusing to save 0 kcal unless typed in as a custom item")
	}
	pr := f(in.ProteinG, 0)
	if pr < 0 || pr > 300 || f(in.CarbsG, 0) < 0 || f(in.FatG, 0) < 0 {
		return bad(400, "protein_g, carbs_g and fat_g must be >= 0 (protein <= 300)")
	}
	unit := in.Unit
	if unit == "" {
		unit = "count"
	}
	src := in.Source
	if src == "manual" {
		src = "custom"
	}
	k := *in.Kcal
	return Entry{CustomName: name, Name: name, Qty: in.Qty, Unit: unit, KcalBest: k, KcalLow: f(in.KcalLow, k), KcalHigh: f(in.KcalHigh, k),
		ProteinBest: pr, ProteinLow: f(in.ProteinLow, pr), ProteinHigh: f(in.ProteinHigh, pr), CarbsG: f(in.CarbsG, 0), FatG: f(in.FatG, 0),
		Source: src, Confirmed: true, ClientID: cid, TableVer: in.DishTableVersion, State: state}, 0, nil
}

// draft stores a needs_review item as sent: numbers are optional display
// estimates (table numbers when a known dish_id is given) and never counted.
func (s *Service) draft(in ItemIn, cid *string) (Entry, int, error) {
	e := Entry{Qty: in.Qty, Unit: in.Unit, OilLevel: in.OilLevel, CustomName: strings.TrimSpace(in.CustomName),
		Source: in.Source, ClientID: cid, TableVer: in.DishTableVersion, State: "needs_review"}
	if e.Unit == "" {
		e.Unit = "count"
	}
	if in.DishID != "" {
		it, err := s.parser().Recompute(in.DishID, in.Qty, in.Unit, in.OilLevel)
		if err != nil {
			return e, 400, err
		}
		id := it.DishID
		e.DishID, e.Name, e.Qty, e.Unit = &id, it.Name, it.Quantity, it.Unit
		e.KcalBest, e.KcalLow, e.KcalHigh = it.Kcal.Best, it.Kcal.Low, it.Kcal.High
		e.ProteinBest, e.ProteinLow, e.ProteinHigh = it.Protein.Best, it.Protein.Low, it.Protein.High
		e.CarbsG, e.FatG = it.CarbsG, it.FatG
	} else if e.CustomName == "" || len(e.CustomName) > 120 {
		return e, 400, errors.New("each item needs dish_id or custom_name")
	}
	if in.Kcal != nil {
		e.KcalBest = *in.Kcal
		e.KcalLow, e.KcalHigh = f(in.KcalLow, e.KcalBest), f(in.KcalHigh, e.KcalBest)
	}
	if in.ProteinG != nil {
		e.ProteinBest = *in.ProteinG
		e.ProteinLow, e.ProteinHigh = f(in.ProteinLow, e.ProteinBest), f(in.ProteinHigh, e.ProteinBest)
	}
	e.CarbsG, e.FatG = f(in.CarbsG, e.CarbsG), f(in.FatG, e.FatG)
	if e.KcalBest < 0 || e.KcalBest > 5000 || e.ProteinBest < 0 || e.CarbsG < 0 || e.FatG < 0 || e.KcalLow > e.KcalBest || e.KcalHigh < e.KcalBest {
		return e, 400, errors.New("numbers out of range")
	}
	if !saveSources[e.Source] {
		e.Source = "custom"
	}
	if e.Name == "" {
		e.Name = e.CustomName
	}
	return e, 0, nil
}

const cols = `id,local_date,slot,raw_text,dish_id,custom_name,qty,unit,oil_level,kcal_best,kcal_low,kcal_high,protein_best,protein_low,protein_high,source,confirmed,created_at,updated_at,deleted_at,client_id,dish_table_version,carbs_g,fat_g,span,state,span_part,parse_job_id,client_item_id,version`

func (s *Service) scan(row pgx.Row) (Entry, error) {
	var e Entry
	var d time.Time
	var del *time.Time
	err := row.Scan(&e.ID, &d, &e.Slot, &e.RawText, &e.DishID, &e.CustomName, &e.Qty, &e.Unit, &e.OilLevel,
		&e.KcalBest, &e.KcalLow, &e.KcalHigh, &e.ProteinBest, &e.ProteinLow, &e.ProteinHigh, &e.Source, &e.Confirmed, &e.CreatedAt, &e.UpdatedAt, &del, &e.ClientID, &e.TableVer, &e.CarbsG, &e.FatG, &e.Span, &e.State, &e.SpanPart, &e.ParseJobID, &e.ClientItemID, &e.Version)
	e.LocalDate = d.Format("2006-01-02")
	e.Name = e.CustomName
	if e.DishID != nil {
		if dd, ok := s.parser().Dish(*e.DishID); ok {
			e.Name = dd.Name
		}
	}
	if del != nil {
		x := del.UTC().Format(time.RFC3339)
		e.DeletedAt = &x
	}
	return e, err
}

func (s *Service) Routes(mux *http.ServeMux, wrap func(http.Handler) http.Handler) {
	mux.Handle("POST /v1/parse", wrap(http.HandlerFunc(s.handleParse)))
	mux.Handle("GET /v1/parse/jobs/{id}", wrap(http.HandlerFunc(s.handleJob)))
	mux.Handle("POST /v1/parse/jobs/{id}/abandon", wrap(http.HandlerFunc(s.handleAbandon)))
	mux.Handle("GET /v1/dishes", http.HandlerFunc(s.handleDishes)) // public: the app's offline table
	mux.Handle("POST /v1/entries", wrap(http.HandlerFunc(s.handleCreate)))
	mux.Handle("GET /v1/entries", wrap(http.HandlerFunc(s.handleList)))
	mux.Handle("GET /v1/entries/{id}", wrap(http.HandlerFunc(s.handleGetOne)))
	mux.Handle("PATCH /v1/entries/{id}", wrap(http.HandlerFunc(s.handlePatch)))
	mux.Handle("DELETE /v1/entries/{id}", wrap(http.HandlerFunc(s.handleDelete)))
	mux.Handle("GET /v1/sync/entries", wrap(http.HandlerFunc(s.handleSync)))
	mux.Handle("GET /v1/remembered", wrap(http.HandlerFunc(s.handleListReadings)))
	mux.Handle("DELETE /v1/remembered/{id}", wrap(http.HandlerFunc(s.handleResetReading)))
	mux.Handle("DELETE /v1/remembered", wrap(http.HandlerFunc(s.handleResetAllReadings)))
}

func (s *Service) handleParse(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Text  string `json:"text"`
		UseAI *bool  `json:"use_ai"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	in.Text = strings.TrimSpace(in.Text)
	if in.Text == "" || len(in.Text) > 500 {
		httpx.Error(w, 400, "text must be 1-500 characters")
		return
	}
	useAI := in.UseAI == nil || *in.UseAI
	out, job := s.Parse(r.Context(), httpx.UserID(r), in.Text, useAI)
	out.NextResetAt = s.nextResetAt()
	if job != nil {
		httpx.JSON(w, 202, out)
		return
	}
	httpx.JSON(w, 200, out)
}

func (s *Service) handleDishes(w http.ResponseWriter, r *http.Request) {
	p := s.parser()
	w.Header().Set("X-Dish-Table-Version", strconv.Itoa(p.TableVersion()))
	httpx.JSON(w, 200, p.Table())
}

func (s *Service) handleCreate(w http.ResponseWriter, r *http.Request) {
	var in struct {
		LocalDate string   `json:"local_date"`
		Slot      string   `json:"slot"`
		Text      string   `json:"text"`
		Items     []ItemIn `json:"items"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	day, err := httpx.Day(in.LocalDate)
	if err != nil {
		httpx.Error(w, 400, err.Error())
		return
	}
	if in.Slot == "" {
		in.Slot = httpx.SlotFor(httpx.Now())
	}
	if !slots[in.Slot] {
		httpx.Error(w, 400, "slot must be breakfast, lunch, snacks or dinner")
		return
	}
	items := in.Items
	var unmatched []string
	toConfirm := []parser.Item{}
	if len(items) == 0 && strings.TrimSpace(in.Text) != "" {
		// convenience: save only confident table matches; the rest comes back to confirm
		p := s.parser().Parse(in.Text)
		strict := s.parser().TableOnly(p)
		for _, it := range p.Items {
			// text-only saves never skip the app's confirm for a guessed portion
			if it.NeedsConfirmation || !strict || it.DefaultPortion {
				it.NeedsConfirmation, it.OneTapOK = true, false
				toConfirm = append(toConfirm, it)
				continue
			}
			// a variant the text named ("veg biryani") counts as the user's pick
			items = append(items, ItemIn{DishID: it.DishID, Qty: it.Quantity, Unit: it.Unit, OilLevel: it.OilLevel, Source: it.Source, VariantDishID: it.DishID})
		}
		unmatched = p.Unmatched
	}
	if len(items) == 0 && len(toConfirm) > 0 {
		httpx.JSON(w, 200, map[string]any{"entries": []Entry{}, "duplicates": []string{}, "unmatched": unmatched, "needs_confirmation": toConfirm})
		return
	}
	if len(items) == 0 || len(items) > 30 {
		httpx.Error(w, 400, "give 1-30 items, or text the table recognises")
		return
	}
	uid := httpx.UserID(r)
	tx, err := s.DB.Begin(r.Context())
	if err != nil {
		httpx.Error(w, 500, "db")
		return
	}
	defer tx.Rollback(r.Context())
	out := []Entry{}
	dups := []string{}
	created := 0
	spanParts := map[string]int{} // item index within each span (multi-item remembered foods)
	for i, it := range items {
		if it.ClientID != "" {
			// idempotent: a repeat client_id returns the stored entry unchanged
			ex, err := s.scan(tx.QueryRow(r.Context(), `SELECT `+cols+` FROM food_entries WHERE user_id=$1 AND client_id=$2`, uid, it.ClientID))
			if err == nil {
				out, dups = append(out, ex), append(dups, it.ClientID)
				continue
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				httpx.Error(w, 500, "db")
				return
			}
		}
		part := 0
		if k := Normalize(it.Span); k != "" {
			part = spanParts[k]
			spanParts[k]++
		}
		if body := s.choiceCheck(in.Text, it, i); body != nil {
			httpx.JSON(w, 422, body)
			return
		}
		// a late AI reading for a job the app abandoned is never saved (the user's typed kcal stands)
		if it.Source == "ai_estimate" && s.jobAbandoned(r.Context(), uid, it.jobID()) {
			httpx.JSON(w, 409, abandonedBody(i, it.jobID()))
			return
		}
		e, code, err := s.resolve(r.Context(), it)
		if err != nil {
			if uv, ok := err.(*unknownVersion); ok {
				httpx.JSON(w, 409, uv.body(i))
				return
			}
			httpx.Error(w, code, "item "+strconv.Itoa(i)+": "+err.Error())
			return
		}
		saved, err := s.scan(tx.QueryRow(r.Context(), `INSERT INTO food_entries(user_id,local_date,slot,raw_text,dish_id,custom_name,qty,unit,oil_level,
			kcal_best,kcal_low,kcal_high,protein_best,protein_low,protein_high,source,confirmed,client_id,dish_table_version,carbs_g,fat_g,span,state,span_part,parse_job_id,client_item_id)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,COALESCE(NULLIF($23,''),'confirmed'),$24,NULLIF($25,''),NULLIF($26,'')) RETURNING `+cols,
			uid, day, in.Slot, in.Text, e.DishID, e.CustomName, e.Qty, e.Unit, e.OilLevel,
			e.KcalBest, e.KcalLow, e.KcalHigh, e.ProteinBest, e.ProteinLow, e.ProteinHigh, e.Source, e.Confirmed,
			e.ClientID, e.TableVer, e.CarbsG, e.FatG, Normalize(it.Span), e.State, part, it.jobID(), it.ClientItemID))
		if err != nil {
			httpx.Error(w, 500, "save failed")
			return
		}
		out = append(out, saved)
		created++
		if it.Confirmed && it.Span != "" && saved.State == "confirmed" {
			if err := remember(r.Context(), tx, uid, it.Span, part, part == 0, saved); err != nil {
				httpx.Error(w, 500, "save failed")
				return
			}
		}
	}
	_, _ = tx.Exec(r.Context(), `INSERT INTO events(user_id,name,props) VALUES ($1,'log',jsonb_build_object('items',$2::int))`, uid, len(out))
	if err := tx.Commit(r.Context()); err != nil {
		httpx.Error(w, 500, "save failed")
		return
	}
	sum, err := s.Summary.Rebuild(r.Context(), uid, day)
	if err != nil {
		httpx.Error(w, 500, "summary failed")
		return
	}
	if unmatched == nil {
		unmatched = []string{}
	}
	code := 201
	if created == 0 {
		code = 200 // every item was a repeat
	}
	httpx.JSON(w, code, map[string]any{"entries": out, "duplicates": dups, "unmatched": unmatched, "needs_confirmation": toConfirm, "summary": sum})
}

func (s *Service) handleList(w http.ResponseWriter, r *http.Request) {
	day, ok := httpx.DayParam(w, r)
	if !ok {
		return
	}
	rows, err := s.DB.Query(r.Context(), `SELECT `+cols+` FROM food_entries WHERE user_id=$1 AND local_date=$2 AND deleted_at IS NULL ORDER BY created_at,id`, httpx.UserID(r), day)
	if err != nil {
		httpx.Error(w, 500, "db")
		return
	}
	defer rows.Close()
	out := []Entry{}
	for rows.Next() {
		e, err := s.scan(rows)
		if err != nil {
			httpx.Error(w, 500, "db")
			return
		}
		out = append(out, e)
	}
	httpx.JSON(w, 200, map[string]any{"local_date": day.Format("2006-01-02"), "entries": out, "total": entryTotals(out)})
}

func entryTotals(es []Entry) Total {
	var t Total
	for _, e := range es {
		if e.State == "needs_review" {
			t.NeedsReview++
			continue
		}
		t.Kcal += e.KcalBest
		t.KcalLow += e.KcalLow
		t.KcalHigh += e.KcalHigh
		t.ProteinG += e.ProteinBest
		t.ProteinLow += e.ProteinLow
		t.ProteinHigh += e.ProteinHigh
		t.CarbsG += e.CarbsG
		t.FatG += e.FatG
	}
	return t
}

func (s *Service) load(ctx context.Context, uid int64, r *http.Request) (Entry, int, error) {
	// {id} is the server id, or the app's client_id
	raw := r.PathValue("id")
	var e Entry
	var err error
	if id, perr := strconv.ParseInt(raw, 10, 64); perr == nil {
		e, err = s.scan(s.DB.QueryRow(ctx, `SELECT `+cols+` FROM food_entries WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, id, uid))
	} else {
		e, err = s.scan(s.DB.QueryRow(ctx, `SELECT `+cols+` FROM food_entries WHERE client_id=$1 AND user_id=$2 AND deleted_at IS NULL`, raw, uid))
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return e, 404, errors.New("entry not found")
	}
	if err != nil {
		return e, 500, errors.New("db")
	}
	return e, 0, nil
}

func (s *Service) handleGetOne(w http.ResponseWriter, r *http.Request) {
	e, code, err := s.load(r.Context(), httpx.UserID(r), r)
	if err != nil {
		httpx.Error(w, code, err.Error())
		return
	}
	httpx.JSON(w, 200, e)
}

// handlePatch edits a chip. Dish rows are recomputed from the table; custom
// rows take the given numbers. If the client sends the row version it last saw
// and the row has moved on, it's a 409 version_conflict carrying the current
// row; the client reapplies its own edit on top and retries with that version.
func (s *Service) handlePatch(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Slot       *string  `json:"slot"`
		LocalDate  *string  `json:"local_date"`
		DishID     *string  `json:"dish_id"`
		Qty        *float64 `json:"qty"`
		Unit       *string  `json:"unit"`
		OilLevel   *string  `json:"oil_level"`
		CustomName *string  `json:"custom_name"`
		Kcal       *float64 `json:"kcal"`
		ProteinG   *float64 `json:"protein_g"`
		ProteinAlt *float64 `json:"protein"` // alias
		// IfUnmodSince is accepted from older apps and IGNORED: a phone clock is
		// never a precondition (it jammed queues with permanent 409s).
		IfUnmodSince *time.Time `json:"if_unmodified_since"`
		// Version: the row version the client last saw (from any entry response).
		// Stale -> 409 {"error":{"code":"version_conflict"},"entry": current row}.
		Version *int `json:"version"`
		// Span overrides the stored parsed span; the corrected reading is
		// remembered for it (set "remember": false to skip).
		Span     *string `json:"span"`
		Remember *bool   `json:"remember"`
		// State "confirmed" confirms a needs_review entry (full checks apply).
		State *string `json:"state"`
		// parse_job_id (alias job_id) / client_item_id link the entry to a parse job / app item.
		ParseJobID   *string `json:"parse_job_id"`
		JobID        *string `json:"job_id"`
		ClientItemID *string `json:"client_item_id"`
		// Source (optional) says where the new numbers come from; "ai_estimate"
		// for an entry tied to an abandoned parse job is refused (job_abandoned).
		Source *string `json:"source"`
		// Same checks as POST: variant_dish_id for variant-group dishes,
		// confirmed=true when the (new) span has a vague amount.
		VariantDishID *string `json:"variant_dish_id"`
		Confirmed     *bool   `json:"confirmed"`
	}
	if !httpx.Decode(w, r, &in) {
		return
	}
	if in.ProteinG == nil {
		in.ProteinG = in.ProteinAlt
	}
	uid := httpx.UserID(r)
	e, code, err := s.load(r.Context(), uid, r)
	if err != nil {
		httpx.Error(w, code, err.Error())
		return
	}
	if in.Version != nil && *in.Version != e.Version {
		httpx.JSON(w, 409, versionConflict(e))
		return
	}
	oldDay, _ := time.Parse("2006-01-02", e.LocalDate)
	day := oldDay
	if in.LocalDate != nil {
		if day, err = httpx.Day(*in.LocalDate); err != nil {
			httpx.Error(w, 400, err.Error())
			return
		}
	}
	slot := e.Slot
	if in.Slot != nil {
		if !slots[*in.Slot] {
			httpx.Error(w, 400, "slot must be breakfast, lunch, snacks or dinner")
			return
		}
		slot = *in.Slot
	}
	it := ItemIn{Qty: e.Qty, Unit: e.Unit, OilLevel: e.OilLevel, CustomName: e.CustomName, Source: e.Source, Confirmed: true, State: e.State}
	if in.State != nil {
		it.State = *in.State
	}
	if !saveSources[it.Source] {
		it.Source = "custom"
	}
	if e.DishID != nil {
		it.DishID = *e.DishID
	} else {
		k, p := e.KcalBest, e.ProteinBest
		it.Kcal, it.ProteinG = &k, &p
		if e.Source == "table" || e.Source == "did_you_mean" {
			it.Source = "custom"
		}
	}
	if in.DishID != nil {
		it.DishID = *in.DishID
		if *in.DishID != "" && in.Unit == nil {
			it.Unit = "" // use the new dish's default unit
		}
	}
	if in.Qty != nil {
		// custom items scale their numbers with quantity
		if it.DishID == "" && e.Qty > 0 {
			k, p := *it.Kcal**in.Qty/e.Qty, *it.ProteinG**in.Qty/e.Qty
			it.Kcal, it.ProteinG = &k, &p
		}
		it.Qty = *in.Qty
	}
	if in.Unit != nil {
		it.Unit = *in.Unit
	}
	if in.OilLevel != nil {
		it.OilLevel = *in.OilLevel
	}
	if in.CustomName != nil {
		it.CustomName = *in.CustomName
	}
	if in.Kcal != nil {
		it.Kcal = in.Kcal
	}
	if in.ProteinG != nil {
		it.ProteinG = in.ProteinG
	}
	if it.DishID == "" && in.Kcal != nil {
		it.Source = "custom"
	}
	if in.DishID != nil && *in.DishID != "" {
		it.Source = "table" // user picked the dish
	}
	if it.DishID != "" && it.Source != "custom" {
		it.Kcal, it.ProteinG = nil, nil // edited dish chips are recomputed from the current table
	}
	// job_abandoned applies to AI-source writes only: the client says the numbers are an AI
	// reading, or a counted row keeps its stored AI numbers. A typed kcal (source custom) always
	// goes through, and so does an identity-only edit of a needs_review row (never counted).
	if (in.Source != nil && *in.Source == "ai_estimate") || (it.Source == "ai_estimate" && in.Kcal == nil && it.State != "needs_review") {
		job := deref(in.ParseJobID)
		if job == "" {
			job = deref(in.JobID)
		}
		if job == "" {
			job = deref(e.ParseJobID)
		}
		if s.jobAbandoned(r.Context(), uid, job) {
			httpx.JSON(w, 409, abandonedBody(0, job))
			return
		}
	}
	chk := it
	chk.Confirmed = in.Confirmed != nil && *in.Confirmed
	if in.VariantDishID != nil {
		chk.VariantDishID = *in.VariantDishID
	}
	if in.Span != nil {
		chk.Span = *in.Span
	}
	if body := s.choiceCheck("", chk, 0); body != nil {
		httpx.JSON(w, 422, body)
		return
	}
	ne, code, err := s.resolve(r.Context(), it)
	if uv, ok := err.(*unknownVersion); ok {
		httpx.JSON(w, 409, uv.body(0))
		return
	}
	if err != nil {
		httpx.Error(w, code, err.Error())
		return
	}
	saved, err := s.scan(s.DB.QueryRow(r.Context(), `UPDATE food_entries SET local_date=$3,slot=$4,dish_id=$5,custom_name=$6,qty=$7,unit=$8,oil_level=$9,
		kcal_best=$10,kcal_low=$11,kcal_high=$12,protein_best=$13,protein_low=$14,protein_high=$15,source=$16,confirmed=($20<>'needs_review'),
		dish_table_version=COALESCE($17,dish_table_version),carbs_g=$18,fat_g=$19,state=COALESCE(NULLIF($20,''),'confirmed'),updated_at=now()
		WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL AND ($21::int IS NULL OR version=$21) RETURNING `+cols, e.ID, uid, day, slot, ne.DishID, ne.CustomName, ne.Qty, ne.Unit, ne.OilLevel,
		ne.KcalBest, ne.KcalLow, ne.KcalHigh, ne.ProteinBest, ne.ProteinLow, ne.ProteinHigh, ne.Source, ne.TableVer, ne.CarbsG, ne.FatG, ne.State, in.Version))
	if errors.Is(err, pgx.ErrNoRows) {
		// Another write landed between the load and this update (the update is atomic on
		// version and deleted_at): a delete wins (404, the same as a PATCH after the delete);
		// a newer version is a 409 with the current row. Never a 500.
		cur, code, lerr := s.load(r.Context(), uid, r)
		if lerr != nil {
			httpx.Error(w, code, lerr.Error())
			return
		}
		if in.Version != nil {
			httpx.JSON(w, 409, versionConflict(cur))
			return
		}
		httpx.Error(w, 409, "entry changed while saving; retry")
		return
	}
	if err != nil {
		httpx.Error(w, 500, "save failed")
		return
	}
	if in.ParseJobID == nil {
		in.ParseJobID = in.JobID
	}
	if in.ParseJobID != nil || in.ClientItemID != nil {
		_ = s.DB.QueryRow(r.Context(), `UPDATE food_entries SET parse_job_id=COALESCE(NULLIF($3,''),parse_job_id), client_item_id=COALESCE(NULLIF($4,''),client_item_id)
			WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL RETURNING version`, e.ID, uid, deref(in.ParseJobID), deref(in.ClientItemID)).Scan(&saved.Version)
		saved.ParseJobID, saved.ClientItemID = orPtr(in.ParseJobID, saved.ParseJobID), orPtr(in.ClientItemID, saved.ClientItemID)
	}
	span := e.Span
	if in.Span != nil {
		span = *in.Span
	}
	corrected := in.DishID != nil || in.Qty != nil || in.Unit != nil || in.OilLevel != nil || in.CustomName != nil || in.Kcal != nil || in.ProteinG != nil
	if corrected && span != "" && saved.State == "confirmed" && (in.Remember == nil || *in.Remember) {
		if err := remember(r.Context(), s.DB, uid, span, e.SpanPart, false, saved); err != nil {
			httpx.Error(w, 500, "save failed")
			return
		}
	}
	if !day.Equal(oldDay) {
		if _, err := s.Summary.Rebuild(r.Context(), uid, oldDay); err != nil {
			httpx.Error(w, 500, "summary failed")
			return
		}
	}
	if _, err := s.Summary.Rebuild(r.Context(), uid, day); err != nil {
		httpx.Error(w, 500, "summary failed")
		return
	}
	httpx.JSON(w, 200, saved)
}

// versionConflict: 409 body for a stale PATCH version, with the server's current row.
func versionConflict(e Entry) map[string]any {
	return map[string]any{"error": map[string]any{"code": "version_conflict", "version": e.Version,
		"message": "entry changed on the server; reapply your edit on this version"}, "entry": e}
}

func (s *Service) handleDelete(w http.ResponseWriter, r *http.Request) {
	uid := httpx.UserID(r)
	e, code, err := s.load(r.Context(), uid, r)
	if err != nil {
		httpx.Error(w, code, err.Error())
		return
	}
	if _, err := s.DB.Exec(r.Context(), `UPDATE food_entries SET deleted_at=now(), updated_at=now() WHERE id=$1 AND user_id=$2`, e.ID, uid); err != nil {
		httpx.Error(w, 500, "delete failed")
		return
	}
	day, _ := time.Parse("2006-01-02", e.LocalDate)
	if _, err := s.Summary.Rebuild(r.Context(), uid, day); err != nil {
		httpx.Error(w, 500, "summary failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleSync returns every entry changed since ?since= (RFC 3339), including
// soft-deleted ones, so the app's SQLite copy can catch up.
func (s *Service) handleSync(w http.ResponseWriter, r *http.Request) {
	since := time.Unix(0, 0)
	if v := r.URL.Query().Get("since"); v != "" {
		t, err := time.Parse(time.RFC3339Nano, v)
		if err != nil {
			httpx.Error(w, 400, "since must be RFC 3339")
			return
		}
		since = t
	}
	rows, err := s.DB.Query(r.Context(), `SELECT `+cols+` FROM food_entries WHERE user_id=$1 AND updated_at>$2 ORDER BY updated_at LIMIT 1000`, httpx.UserID(r), since)
	if err != nil {
		httpx.Error(w, 500, "db")
		return
	}
	defer rows.Close()
	out := []Entry{}
	for rows.Next() {
		e, err := s.scan(rows)
		if err != nil {
			httpx.Error(w, 500, "db")
			return
		}
		out = append(out, e)
	}
	httpx.JSON(w, 200, map[string]any{"entries": out, "server_time": time.Now().UTC().Format(time.RFC3339Nano)})
}

// ---------- summary contributor ----------

type Contributor struct{}

func (Contributor) Name() string { return "food" }

func (Contributor) Contribute(ctx context.Context, q summary.Querier, uid int64, day time.Time, d *summary.Day) error {
	var n int
	err := q.QueryRow(ctx, `SELECT COALESCE(SUM(kcal_best) FILTER (WHERE state<>'needs_review'),0), COALESCE(SUM(protein_best) FILTER (WHERE state<>'needs_review'),0), COUNT(*) FROM food_entries
		WHERE user_id=$1 AND local_date=$2 AND deleted_at IS NULL`, uid, day).Scan(&d.KcalIn, &d.ProteinIn, &n)
	d.Logged = d.Logged || n > 0 // any entry, including needs_review, counts for the streak
	return err
}

// plausible: every AI item must be over 0 and under 3000 kcal.
func plausible(items []parser.Item) bool {
	if len(items) == 0 {
		return false
	}
	for _, it := range items {
		if it.Kcal.Best <= 0 || it.Kcal.Best >= 3000 || it.Kcal.High >= 3000 {
			return false
		}
	}
	return true
}

// unknownVersion: the client used a table this server has never seen (e.g.
// the app updated before this server). The entry is fine; retry later.
type unknownVersion struct{ got, server int }

func (u *unknownVersion) Error() string {
	return fmt.Sprintf("dish_table_version %d is not known to this server", u.got)
}

func (u *unknownVersion) body(item int) map[string]any {
	return map[string]any{
		"error":              "unknown_dish_table_version",
		"message":            "Keep this entry on the device and retry later. The server doesn't know this dish table version yet.",
		"item":               item,
		"dish_table_version": u.got,
		"server_version":     u.server,
		"keep_entry":         true,
		"retry":              true,
	}
}

func (in ItemIn) jobID() string {
	if in.ParseJobID != "" {
		return in.ParseJobID
	}
	return in.JobID
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func orPtr(a, b *string) *string {
	if a != nil && *a != "" {
		return a
	}
	return b
}

func hasFlag(fs []string, f string) bool {
	for _, x := range fs {
		if x == f {
			return true
		}
	}
	return false
}

func appendFlag(fs []string, f string) []string {
	if hasFlag(fs, f) {
		return fs
	}
	return append(fs, f)
}

// chargeAI counts one more Gemini send of an already-queued meal against
// the project-wide counter (AI_DAILY_CAP counts every attempt). The send
// already happened, so it is counted even past the cap (the counter must not
// think there are calls left after Google's real limit has run out).
// AI_USER_DAILY_CAP is NOT charged again: a user's meal (job) uses one unit
// of it however many attempts it takes (reserved once when it was queued).
func (s *Service) chargeAI(ctx context.Context, userID int64) {
	if s.DB == nil {
		return
	}
	_ = userID
	today := s.Quota.Day(httpx.Now())
	_, _ = s.DB.Exec(ctx, `INSERT INTO ai_global_usage(local_date,calls) VALUES ($1,1)
		ON CONFLICT (local_date) DO UPDATE SET calls=ai_global_usage.calls+1`, today)
}

// logAICall stores one row per AI attempt in ai_calls (user id, meal id = job id, timestamp,
// model, outcome, HTTP sends that reached Gemini). Best effort: a failed
// insert never changes the meal's answer.
func (s *Service) logAICall(ctx context.Context, j *Job, sends int, outcome string) {
	if s.DB == nil {
		return
	}
	model := ""
	if m, ok := s.Fallback.(interface{ ModelName() string }); ok {
		model = m.ModelName()
	}
	if _, err := s.DB.Exec(ctx, `INSERT INTO ai_calls(user_id,meal_id,created_at,model,outcome,sends,requeue) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
		j.UserID, j.ID, httpx.Now(), model, outcome, sends, j.Requeues); err != nil {
		log.Printf("ai_calls insert failed: job=%s err=%v", j.ID, err)
	}
}

// globalCapFull: AI_DAILY_CAP is set and already used up today.
func (s *Service) globalCapFull(ctx context.Context) bool {
	gc := s.GlobalCap.Load()
	if gc <= 0 || s.DB == nil {
		return false
	}
	var used int64
	_ = s.DB.QueryRow(ctx, `SELECT COALESCE((SELECT calls FROM ai_global_usage WHERE local_date=$1),0)`, s.Quota.Day(httpx.Now())).Scan(&used)
	return used >= gc
}

// releaseAI gives back a call reserved by reserveAI that was never made.
func (s *Service) releaseAI(ctx context.Context, userID int64) {
	today := s.Quota.Day(httpx.Now())
	_, _ = s.DB.Exec(ctx, `UPDATE ai_usage SET calls=calls-1 WHERE user_id=$1 AND local_date=$2 AND calls>0`, userID, today)
	_, _ = s.DB.Exec(ctx, `UPDATE ai_global_usage SET calls=calls-1 WHERE local_date=$1 AND calls>0`, today)
}

// choiceCheck refuses a save the user never actually chose: a table item
// read from an ambiguous base dish ("biryani") without variant_dish_id from
// variant_options (variant_required), or one read with a vague amount
// ("thoda rajma") without confirmed=true (confirmation_required). The text
// checked is the item's span, else the request's text.
func (s *Service) choiceCheck(text string, it ItemIn, i int) map[string]any {
	if it.DishID == "" || it.Source == "ai_estimate" || it.Source == "custom" || it.Source == "manual" || it.State == "needs_review" {
		return nil
	}
	// variant: keyed on the dish itself, whatever span/text says (or omits)
	if opts := s.parser().VariantGroup(it.DishID, it.Qty, it.Unit); len(opts) > 0 {
		ok := false
		for _, o := range opts {
			ok = ok || (o.DishID == it.VariantDishID && it.VariantDishID == it.DishID)
		}
		if !ok {
			return map[string]any{"error": map[string]any{"code": "variant_required", "item": i, "dish_id": it.DishID,
				"message":         "Pick which one this was. Send the chosen variant as dish_id and variant_dish_id.",
				"variant_options": opts}}
		}
	}
	vague := false
	for _, t := range []string{it.Span, text} {
		_, v := s.parser().Choices(t, it.DishID)
		vague = vague || v
	}
	if vague && !it.Confirmed {
		return map[string]any{"error": map[string]any{"code": "quantity_required", "reason": "vague_quantity", "item": i, "dish_id": it.DishID,
			"message": "The amount was vague (thoda, zyada). Check the portion and send confirmed=true."}}
	}
	return nil
}
