package store_test

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// The no-SQL-outside-store check: every SQL statement lives in
// internal/store. It scans the module's non-test Go files outside
// internal/store and fails on
//   - an import of pgx itself or its pgconn / pgtype packages (pgxpool, the
//     pool handle the services pass to the store, is allowed),
//   - a string literal that reads as SQL (keywords in capitals),
//   - a call of Exec, Query, QueryRow, SendBatch or CopyFrom with a context
//     and arguments (a database call).
// Test files are not scanned: they set up and inspect rows directly.

// SQL keywords are matched in capitals, as every statement here is written;
// pg_advisory in any case.
var sqlText = regexp.MustCompile(`\b(SELECT\b(?s:.+)\bFROM\b|INSERT\s+INTO\b|UPDATE\s+\w+\s+SET\b|DELETE\s+FROM\b|` +
	`CREATE\s+(TABLE|INDEX|UNIQUE|EXTENSION|SCHEMA)\b|ALTER\s+TABLE\b|DROP\s+(TABLE|SCHEMA|DATABASE|INDEX)\b|` +
	`TRUNCATE\s+\w+|RETURNING\s+\w+|(?i:pg_advisory))`)

var dbCalls = map[string]bool{"Exec": true, "Query": true, "QueryRow": true, "SendBatch": true, "CopyFrom": true}

// sqlProblems lists the SQL found in one Go source file.
func sqlProblems(fset *token.FileSet, name string, src any) ([]string, error) {
	f, err := parser.ParseFile(fset, name, src, 0)
	if err != nil {
		return nil, err
	}
	var out []string
	at := func(n ast.Node, what string) { out = append(out, fmt.Sprintf("%s: %s", fset.Position(n.Pos()), what)) }
	for _, im := range f.Imports {
		p, _ := strconv.Unquote(im.Path.Value)
		if p == "github.com/jackc/pgx/v5" || (strings.HasPrefix(p, "github.com/jackc/pgx/v5/") && p != "github.com/jackc/pgx/v5/pgxpool") {
			at(im, "imports "+p)
		}
	}
	ast.Inspect(f, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.BasicLit:
			if x.Kind == token.STRING {
				if s, err := strconv.Unquote(x.Value); err == nil && sqlText.MatchString(s) {
					at(x, "SQL text "+strconv.Quote(firstLine(s)))
				}
			}
		case *ast.CallExpr:
			if sel, ok := x.Fun.(*ast.SelectorExpr); ok && dbCalls[sel.Sel.Name] && len(x.Args) >= 2 {
				at(x, "database call ."+sel.Sel.Name)
			}
		}
		return true
	})
	return out, nil
}

func firstLine(s string) string {
	s, _, _ = strings.Cut(strings.TrimSpace(s), "\n")
	if len(s) > 60 {
		s = s[:60] + "..."
	}
	return s
}

func moduleRoot(t *testing.T) string {
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		up := filepath.Dir(dir)
		if up == dir {
			t.Fatal("go.mod not found")
		}
		dir = up
	}
}

func TestNoSQLOutsideStore(t *testing.T) {
	root := moduleRoot(t)
	storeDir := filepath.Join(root, "internal", "store")
	fset := token.NewFileSet()
	scanned := 0
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			switch {
			case path == storeDir, d.Name() == "testdata", d.Name() == "vendor", d.Name() == "node_modules",
				path != root && strings.HasPrefix(d.Name(), "."):
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		scanned++
		probs, err := sqlProblems(fset, path, nil)
		if err != nil {
			return err
		}
		for _, p := range probs {
			rel, _ := filepath.Rel(root, p)
			if rel == "" || strings.HasPrefix(rel, "..") {
				rel = p
			}
			t.Errorf("SQL outside internal/store: %s", rel)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if scanned < 20 {
		t.Fatalf("scanned only %d files; the walk is broken", scanned)
	}
}

// The check itself must catch each kind of SQL.
func TestNoSQLCheckCatches(t *testing.T) {
	cases := map[string]string{
		"pgx import": `package x; import "github.com/jackc/pgx/v5"; var _ = pgx.ErrNoRows`,
		"pgconn":     `package x; import "github.com/jackc/pgx/v5/pgconn"; var _ pgconn.PgError`,
		"select":     "package x; const q = `SELECT id FROM users WHERE id=$1`",
		"insert":     `package x; var q = "INSERT INTO t(a) VALUES ($1)"`,
		"update":     "package x; const q = `UPDATE users SET name=$2 WHERE id=$1`",
		"delete":     "package x; const q = `DELETE FROM ai_cache`",
		"lock":       "package x; const q = `SELECT pg_advisory_xact_lock(1)`",
		"db call":    `package x; func f(db interface{ Exec(a, b any) }) { db.Exec(nil, q) }; var q string`,
	}
	for name, src := range cases {
		probs, err := sqlProblems(token.NewFileSet(), name+".go", src)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if len(probs) == 0 {
			t.Errorf("%s: not caught", name)
		}
	}
	clean := `package x; import "github.com/jackc/pgx/v5/pgxpool"; var _ *pgxpool.Pool; var m = "select a meal from the list"; func f(r interface{ Query() int }) { r.Query() }`
	if probs, _ := sqlProblems(token.NewFileSet(), "clean.go", clean); len(probs) != 0 {
		t.Errorf("clean source flagged: %v", probs)
	}
}
