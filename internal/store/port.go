package store

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

// DumpFormat names the JSON dump layout; Import refuses anything else.
const DumpFormat = "stoke-dump-v1"

type table struct {
	name    string
	hasUser bool // a user_id column (users itself is keyed by id)
	cols    []string
	deps    []string
}

// tables: every table of the current schema except schema_migrations, parents before children (FK order).
func tables(ctx context.Context, q querier) ([]table, error) {
	rows, err := q.Query(ctx, `SELECT c.relname,
		  EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='user_id' AND NOT a.attisdropped),
		  ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND a.attgenerated='' ORDER BY a.attnum),
		  ARRAY(SELECT DISTINCT f.relname::text FROM pg_constraint k JOIN pg_class f ON f.oid=k.confrelid WHERE k.conrelid=c.oid AND k.contype='f' AND f.oid<>c.oid)
		FROM pg_class c WHERE c.relnamespace=current_schema()::regnamespace AND c.relkind IN ('r','p') AND c.relname<>'schema_migrations'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	all := map[string]table{}
	for rows.Next() {
		var t table
		if err := rows.Scan(&t.name, &t.hasUser, &t.cols, &t.deps); err != nil {
			return nil, err
		}
		all[t.name] = t
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	names := make([]string, 0, len(all))
	for n := range all {
		names = append(names, n)
	}
	sort.Strings(names)
	var out []table
	seen := map[string]int{} // 1 visiting, 2 done
	var visit func(n string) error
	visit = func(n string) error {
		switch seen[n] {
		case 2:
			return nil
		case 1:
			return fmt.Errorf("foreign key cycle at %s", n)
		}
		seen[n] = 1
		for _, d := range all[n].deps {
			if _, ok := all[d]; ok {
				if err := visit(d); err != nil {
					return err
				}
			}
		}
		seen[n] = 2
		out = append(out, all[n])
		return nil
	}
	for _, n := range names {
		if err := visit(n); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func quoteIdent(s string) string { return pgx.Identifier{s}.Sanitize() }

// Export: every table's rows as JSON (uid == nil), or one user's rows: users.id = uid and every table with a user_id
// column (shared tables such as the dish table are skipped then). One repeatable-read snapshot.
func (s *PG) Export(ctx context.Context, uid *int64) (Dump, error) {
	d := Dump{Format: DumpFormat, UserID: uid, Rows: map[string][]json.RawMessage{}, Created: time.Now().UTC()}
	tx, err := s.DB.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return d, err
	}
	defer tx.Rollback(ctx)
	ts, err := tables(ctx, tx)
	if err != nil {
		return d, err
	}
	for _, t := range ts {
		where, args := "", []any{}
		if uid != nil {
			switch {
			case t.name == "users":
				where, args = " WHERE id=$1", []any{*uid}
			case t.hasUser:
				where, args = " WHERE user_id=$1", []any{*uid}
			default:
				continue
			}
		}
		var raw []byte
		if err := tx.QueryRow(ctx, `SELECT coalesce(json_agg(row_to_json(t)),'[]') FROM `+quoteIdent(t.name)+` t`+where, args...).Scan(&raw); err != nil {
			return d, fmt.Errorf("%s: %w", t.name, err)
		}
		var rs []json.RawMessage
		if err := json.Unmarshal(raw, &rs); err != nil {
			return d, err
		}
		d.Tables = append(d.Tables, t.name)
		d.Rows[t.name] = rs
	}
	return d, nil
}

// Import restores a dump into this database (migrated, same schema), in one transaction: plain INSERTs in FK order,
// so a row that already exists fails the whole import (nothing is merged or overwritten). Serial sequences are moved
// past the restored ids.
func (s *PG) Import(ctx context.Context, d Dump) error {
	if d.Format != DumpFormat {
		return fmt.Errorf("not a %s dump (format %q)", DumpFormat, d.Format)
	}
	return inTx(ctx, s, func(tx pgx.Tx) error {
		ts, err := tables(ctx, tx)
		if err != nil {
			return err
		}
		known := map[string]bool{}
		for _, t := range ts {
			known[t.name] = true
		}
		for _, n := range d.Tables {
			if !known[n] {
				return fmt.Errorf("table %s is not in this database (run the migrations first)", n)
			}
		}
		for _, t := range ts {
			rs := d.Rows[t.name]
			if len(rs) == 0 {
				continue
			}
			raw, _ := json.Marshal(rs)
			cols := ""
			for i, c := range t.cols {
				if i > 0 {
					cols += ","
				}
				cols += quoteIdent(c)
			}
			tn := quoteIdent(t.name)
			if _, err := tx.Exec(ctx, `INSERT INTO `+tn+` (`+cols+`) SELECT `+cols+` FROM json_populate_recordset(null::`+tn+`, $1::json)`, raw); err != nil {
				return fmt.Errorf("%s: %w", t.name, err)
			}
			for _, c := range t.cols {
				var seq *string
				if err := tx.QueryRow(ctx, `SELECT pg_get_serial_sequence($1, $2)`, t.name, c).Scan(&seq); err != nil {
					return err
				}
				if seq != nil {
					if _, err := tx.Exec(ctx, `SELECT setval($1, greatest((SELECT coalesce(max(`+quoteIdent(c)+`),0) FROM `+tn+`), 1))`, *seq); err != nil {
						return err
					}
				}
			}
		}
		return nil
	})
}
