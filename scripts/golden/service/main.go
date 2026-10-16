// Reference: food.Service.Parse decision with no AI and no remembered foods (1c617da).
package main

import (
	"encoding/json"
	"os"

	"golden/dishes"
	"golden/parser"
)

func hasFlag(fl []string, f string) bool { for _, x := range fl { if x == f { return true } }; return false }

func main() {
	p, _ := parser.New(dishes.MustLoad())
	var in []string
	b, _ := os.ReadFile(os.Args[1]); json.Unmarshal(b, &in)
	type row struct{ In string `json:"in"`; Items []parser.Item `json:"items"` }
	out := []row{}
	for _, t := range in {
		res := p.Parse(t)
		var items []parser.Item
		if len(res.Items) > 0 && len(res.Unmatched) == 0 && p.TableOnly(res) {
			items = res.Items
		} else {
			for _, it := range res.Items {
				if c, ok := p.Claim(it); ok { items = append(items, c); continue }
				if it.Source == parser.SourceGeneric || hasFlag(it.Flags, "leftover_nearby") { items = append(items, it); continue }
				it.NeedsConfirmation = true
				if it.Source == parser.SourceTable { it.Source = parser.SourceDidYouMean }
				items = append(items, it)
			}
		}
		parser.SetOneTap(items)
		out = append(out, row{t, items})
	}
	json.NewEncoder(os.Stdout).Encode(out)
}
