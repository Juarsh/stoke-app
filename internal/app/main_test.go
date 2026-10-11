package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// testDBURL points at a uniquely named throwaway database created for this
// run and dropped afterwards. Tests never touch calorie_test or any
// existing database.
var testDBURL string

// TEST_PG_ADMIN_URL: a server connection whose role can CREATE DATABASE
// (default postgres://calorie:calorie@localhost:5432/postgres).
func TestMain(m *testing.M) {
	admin := os.Getenv("TEST_PG_ADMIN_URL")
	if admin == "" {
		admin = "postgres://calorie:calorie@localhost:5432/postgres"
	}
	ctx := context.Background()
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	name := "ct_run_" + hex.EncodeToString(b)
	conn, err := pgx.Connect(ctx, admin)
	if err != nil {
		fmt.Fprintln(os.Stderr, "no postgres for integration tests:", err)
		os.Exit(m.Run()) // DB tests skip
	}
	if _, err := conn.Exec(ctx, `CREATE DATABASE `+pgx.Identifier{name}.Sanitize()); err != nil {
		fmt.Fprintln(os.Stderr, "can't create throwaway db:", err)
		conn.Close(ctx)
		os.Exit(m.Run())
	}
	u, _ := url.Parse(admin)
	u.Path = "/" + name
	testDBURL = u.String()
	code := m.Run()
	if !strings.HasPrefix(name, "ct_run_") {
		panic("refusing to drop " + name)
	}
	var err2 error
	for try := 0; try < 40; try++ { // an autovacuum worker can hold the db for a moment
		if _, err2 = conn.Exec(ctx, `DROP DATABASE `+pgx.Identifier{name}.Sanitize()+` WITH (FORCE)`); err2 == nil {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	if err := err2; err != nil {
		fmt.Fprintln(os.Stderr, "drop throwaway db:", err)
		if code == 0 {
			code = 1
		}
	}
	conn.Close(ctx)
	os.Exit(code)
}
