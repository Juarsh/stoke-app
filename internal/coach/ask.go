package coach

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/akarsh/calorie-tracker/internal/httpx"
	"github.com/akarsh/calorie-tracker/internal/store"
)

// DefaultAskCap is the per-user daily question cap.
const DefaultAskCap = 20

// DefaultAskTimeout is how long the model may take before we fall back to rules.
const DefaultAskTimeout = 8 * time.Second

const maxRecent = 6
const maxQuestionRunes = 4000

type foodLister interface {
	ListDay(ctx context.Context, userID int64, day time.Time) ([]store.FoodEntry, error)
}

type history interface {
	ListWorkouts(ctx context.Context, uid int64, from, to string) ([]store.Workout, error)
	ListHabits(ctx context.Context, uid int64) ([]store.Habit, error)
	ListLogs(ctx context.Context, uid int64, from, to string) ([]store.HabitLog, error)
}

type askIn struct {
	Question string    `json:"question"`
	Messages []Message `json:"messages"`
}

func (s *Service) cap() int {
	if s.Cap <= 0 {
		return DefaultAskCap
	}
	return s.Cap
}

func (s *Service) timeout() time.Duration {
	if s.Timeout <= 0 {
		return DefaultAskTimeout
	}
	return s.Timeout
}

func (s *Service) handleAsk(w http.ResponseWriter, r *http.Request) {
	var in askIn
	if !httpx.Decode(w, r, &in) {
		return
	}
	q := strings.TrimSpace(in.Question)
	if q == "" {
		httpx.Error(w, http.StatusBadRequest, "question is required")
		return
	}
	if len([]rune(q)) > maxQuestionRunes {
		httpx.Error(w, http.StatusBadRequest, "question is too long")
		return
	}
	msgs := clipMessages(in.Messages)
	uid := httpx.UserID(r)
	day := httpx.Today()
	ai := s.AI
	if ai == nil {
		ai = NoCoachAI{}
	}

	// No adapter: rules fallback without spending a cap slot.
	if _, ok := ai.(NoCoachAI); ok {
		s.writeRules(w, r.Context(), uid, day, "unavailable")
		return
	}

	if s.Usage != nil {
		_, ok, err := s.Usage.TryCoachAsk(r.Context(), uid, day, s.cap())
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "lookup failed")
			return
		}
		if !ok {
			s.writeRules(w, r.Context(), uid, day, "over_cap")
			return
		}
	}

	ask := Ask{Question: q, Messages: msgs, Context: s.buildContext(r.Context(), uid, day)}
	actx, cancel := context.WithTimeout(r.Context(), s.timeout())
	defer cancel()
	answer, err := ai.Answer(actx, ask)
	if err != nil {
		reason := "ai_error"
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(actx.Err(), context.DeadlineExceeded) {
			reason = "timeout"
		} else if errors.Is(err, ErrNotConfigured) {
			reason = "unavailable"
		}
		s.writeRules(w, r.Context(), uid, day, reason)
		return
	}
	answer = strings.TrimSpace(answer)
	if answer == "" {
		s.writeRules(w, r.Context(), uid, day, "ai_error")
		return
	}
	httpx.JSON(w, 200, map[string]any{"answer": answer, "source": "ai"})
}

func (s *Service) writeRules(w http.ResponseWriter, ctx context.Context, uid int64, day time.Time, reason string) {
	picks := s.rulesPicks(ctx, uid, day)
	httpx.JSON(w, 200, map[string]any{
		"answer": rulesAnswer(reason),
		"source": "rules",
		"reason": reason,
		"picks":  picks,
	})
}

func (s *Service) rulesPicks(ctx context.Context, uid int64, day time.Time) []Pick {
	picks := []Pick{}
	tp := s.Parser
	if s.Table != nil {
		if live := s.Table(); live != nil {
			tp = live
		}
	}
	kcalLeft, proteinLeft := 0.0, 0.0
	if rem := s.remainingOK(ctx, uid, day); rem != nil {
		kcalLeft, proteinLeft = rem.KcalLeft, rem.ProteinLeft
	}
	diet := "nonveg"
	if s.Goals != nil {
		diet = s.Goals.Diet(ctx, uid)
	}
	if tp != nil {
		picks = PicksThatFit(tp, kcalLeft, proteinLeft, diet, 3)
	}
	if picks == nil {
		picks = []Pick{}
	}
	return picks
}

func (s *Service) remainingOK(ctx context.Context, uid int64, day time.Time) *Remaining {
	if s == nil || s.Goals == nil || s.Summary == nil {
		return nil
	}
	rem, err := s.Remaining(ctx, uid, day)
	if err != nil {
		return nil
	}
	return rem
}

func rulesAnswer(reason string) string {
	switch reason {
	case "over_cap":
		return "You've asked 20 questions today, which is the daily limit. Here are picks that fit what's left today."
	case "timeout":
		return "The AI coach took too long, so here are picks that fit what's left today."
	case "unavailable":
		return "The AI coach isn't available right now, so here are picks that fit what's left today."
	default:
		return "The AI coach is unavailable right now, so here are picks that fit what's left today."
	}
}

func clipMessages(in []Message) []Message {
	var out []Message
	for _, m := range in {
		role := m.Role
		if role != "user" && role != "assistant" {
			continue
		}
		text := strings.TrimSpace(m.Text)
		if text == "" {
			continue
		}
		if len([]rune(text)) > maxQuestionRunes {
			text = string([]rune(text)[:maxQuestionRunes])
		}
		out = append(out, Message{Role: role, Text: text})
	}
	if len(out) > maxRecent {
		out = out[len(out)-maxRecent:]
	}
	return out
}

func (s *Service) buildContext(ctx context.Context, uid int64, day time.Time) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Date: %s\n", day.Format("2006-01-02"))
	if rem := s.remainingOK(ctx, uid, day); rem != nil {
		fmt.Fprintf(&b, "Targets: %.0f kcal, %.0f g protein\n", rem.KcalTarget, rem.ProteinTgt)
		fmt.Fprintf(&b, "Logged: %.0f kcal, %.0f g protein\n", rem.KcalIn, rem.ProteinIn)
		fmt.Fprintf(&b, "Left: %.0f kcal, %.0f g protein\n", rem.KcalLeft, rem.ProteinLeft)
	} else {
		b.WriteString("Targets: none set yet\n")
	}
	b.WriteString("Today's foods:")
	if s.Foods != nil {
		foods, err := s.Foods.ListDay(ctx, uid, day)
		if err == nil && len(foods) > 0 {
			limit := 20
			for i, f := range foods {
				if i >= limit {
					fmt.Fprintf(&b, " +%d more", len(foods)-limit)
					break
				}
				name := strings.TrimSpace(f.Name)
				if name == "" {
					name = strings.TrimSpace(f.CustomName)
				}
				if name == "" && f.DishID != nil {
					name = *f.DishID
				}
				if name == "" {
					name = "food"
				}
				fmt.Fprintf(&b, " %s (%.0f kcal, %.0f g protein);", name, f.KcalBest, f.ProteinBest)
			}
		} else {
			b.WriteString(" none")
		}
	} else {
		b.WriteString(" none")
	}
	b.WriteByte('\n')
	from := day.AddDate(0, 0, -6).Format("2006-01-02")
	to := day.Format("2006-01-02")
	b.WriteString("Workouts (7d):")
	if s.Hist != nil {
		if ws, err := s.Hist.ListWorkouts(ctx, uid, from, to); err == nil && len(ws) > 0 {
			for _, w := range ws {
				done := 0
				for _, e := range w.Exercises {
					for _, st := range e.Sets {
						if st.Done {
							done++
						}
					}
				}
				fmt.Fprintf(&b, " %s %s (%d exercises, %d sets done);", w.LocalDate, w.Title, len(w.Exercises), done)
			}
		} else {
			b.WriteString(" none")
		}
	} else {
		b.WriteString(" none")
	}
	b.WriteByte('\n')
	b.WriteString("Habits (7d):")
	if s.Hist != nil {
		habits, _ := s.Hist.ListHabits(ctx, uid)
		logs, _ := s.Hist.ListLogs(ctx, uid, from, to)
		if len(habits) == 0 {
			b.WriteString(" none")
		} else {
			type agg struct {
				done int
				last string
				name string
			}
			by := map[string]*agg{}
			order := []string{}
			for _, h := range habits {
				if h.DeletedAt != nil || h.ArchivedAt != nil {
					continue
				}
				by[h.ID] = &agg{name: h.Name}
				order = append(order, h.ID)
			}
			for _, l := range logs {
				a := by[l.HabitID]
				if a == nil || l.DeletedAt != nil {
					continue
				}
				if l.Done {
					a.done++
				}
				if l.Value != nil {
					a.last = fmt.Sprintf("%d", *l.Value)
				}
			}
			n := 0
			for _, id := range order {
				a := by[id]
				if a == nil {
					continue
				}
				n++
				if n > 12 {
					fmt.Fprintf(&b, " +%d more", len(order)-12)
					break
				}
				if a.last != "" {
					fmt.Fprintf(&b, " %s %d/7 days (last %s);", a.name, a.done, a.last)
				} else {
					fmt.Fprintf(&b, " %s %d/7 days;", a.name, a.done)
				}
			}
			if n == 0 {
				b.WriteString(" none")
			}
		}
	} else {
		b.WriteString(" none")
	}
	b.WriteByte('\n')
	return b.String()
}
