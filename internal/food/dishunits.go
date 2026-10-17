package food

import (
	"bytes"
	"context"
	"encoding/json"

	"github.com/akarsh/calorie-tracker/internal/dishes"
	"github.com/akarsh/calorie-tracker/internal/parser"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DishOut is a dish row as served (GET /v1/dishes) and pulled
// (cmd/dishes-pull): the stored row plus supported_units, the units the
// server saves this dish in (parser.SupportedUnits) for THIS table version.
// The units are derived (dish + rules), never stored in the snapshot, so they
// don't change the version's sha256 and always match the save rule.
type DishOut struct {
	dishes.Dish
	SupportedUnits []string `json:"supported_units"`
}

// WithUnits: the parser's table with each dish's supported units.
func WithUnits(p *parser.Parser) []DishOut {
	t := p.Table()
	out := make([]DishOut, len(t))
	for i, d := range t {
		out[i] = DishOut{Dish: d, SupportedUnits: p.SupportedUnits(d.ID)}
	}
	return out
}

// PullTable: the newest published dish table (admin imports included) with
// its supported units, for cmd/dishes-pull.
func PullTable(ctx context.Context, db *pgxpool.Pool) (version int, out []byte, err error) {
	var raw []byte
	if err = db.QueryRow(ctx, `SELECT version, snapshot FROM dish_table_versions ORDER BY version DESC LIMIT 1`).Scan(&version, &raw); err != nil {
		return 0, nil, err
	}
	var ds []dishes.Dish
	if err = json.Unmarshal(raw, &ds); err != nil {
		return 0, nil, err
	}
	p, err := parser.New(ds)
	if err != nil {
		return 0, nil, err
	}
	out, err = AddUnits(raw, p.SupportedUnits)
	return version, out, err
}

// AddUnits returns a dish table JSON array (raw: dishes.json as kept in the
// repo, or a compact snapshot) with "supported_units" added as the last key
// of every dish, keeping each row's own bytes (no reformatting, so the repo
// diff is only the new key). A row's existing supported_units is replaced.
func AddUnits(raw []byte, units func(id string) []string) ([]byte, error) {
	var rows []json.RawMessage
	if err := json.Unmarshal(raw, &rows); err != nil {
		return nil, err
	}
	var out bytes.Buffer
	out.WriteString("[\n")
	for i, r := range rows {
		var ind bytes.Buffer
		if !bytes.Contains(r, []byte("\n")) { // compact snapshot: indent like the repo file
			if err := json.Indent(&ind, r, " ", " "); err != nil {
				return nil, err
			}
			r = ind.Bytes()
		}
		var m map[string]json.RawMessage
		if err := json.Unmarshal(r, &m); err != nil {
			return nil, err
		}
		var id string
		_ = json.Unmarshal(m["id"], &id)
		if i := bytes.Index(r, []byte(",\n  \"supported_units\": ")); i >= 0 { // ours (last key): cut it
			r = append(append([]byte(nil), r[:i]...), "\n }"...)
		} else if _, had := m["supported_units"]; had { // elsewhere: rebuild this row from the map
			delete(m, "supported_units")
			b, _ := json.MarshalIndent(m, " ", " ")
			r = b
		}
		u, _ := json.MarshalIndent(units(id), "  ", " ")
		body := bytes.TrimRight(r, " \n")
		body = bytes.TrimSuffix(body, []byte("}"))
		body = bytes.TrimRight(body, " \n")
		out.WriteString(" ")
		out.Write(body)
		out.WriteString(",\n  \"supported_units\": ")
		out.Write(u)
		out.WriteString("\n }")
		if i < len(rows)-1 {
			out.WriteString(",")
		}
		out.WriteString("\n")
	}
	out.WriteString("]\n")
	return out.Bytes(), nil
}
