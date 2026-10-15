package app

import (
	"runtime/debug"
	"time"
)

// Commit and BuiltAt are set at build time:
//
//	go build -ldflags "-X github.com/akarsh/calorie-tracker/internal/app.Commit=$(git rev-parse --short HEAD) -X github.com/akarsh/calorie-tracker/internal/app.BuiltAt=$(date -u +%FT%TZ)" ./cmd/api
//
// Without ldflags, Go's embedded VCS info (vcs.revision, vcs.time,
// vcs.modified) is used.
var Commit, BuiltAt string

func version() map[string]any {
	c, b, dirty := Commit, BuiltAt, false
	if bi, ok := debug.ReadBuildInfo(); ok {
		for _, s := range bi.Settings {
			switch s.Key {
			case "vcs.revision":
				if c == "" && len(s.Value) >= 7 {
					c = s.Value[:7]
				}
			case "vcs.time":
				if b == "" {
					b = s.Value
				}
			case "vcs.modified":
				dirty = s.Value == "true"
			}
		}
	}
	if c == "" {
		c = "unknown"
	}
	if b == "" {
		b = startedAt.Format(time.RFC3339)
	}
	return map[string]any{"commit": c, "built_at": b, "dirty": dirty}
}

var startedAt = time.Now().UTC()
