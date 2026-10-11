// Dumps the Go parser's full output for every input, for TS parity tests.
package main

import (
	"encoding/json"
	"os"

	"golden/dishes"
	"golden/parser"
)

func main() {
	p, err := parser.New(dishes.MustLoad())
	if err != nil {
		panic(err)
	}
	var inputs []string
	var dev struct{ Meals []struct{ In string } }
	b, _ := os.ReadFile(os.Args[1])
	json.Unmarshal(b, &dev)
	for _, m := range dev.Meals {
		inputs = append(inputs, m.In)
	}
	var extra []string
	b, _ = os.ReadFile(os.Args[2])
	json.Unmarshal(b, &extra)
	inputs = append(inputs, extra...)
	type row struct {
		In  string        `json:"in"`
		Out parser.Result `json:"out"`
	}
	out := []row{}
	for _, in := range inputs {
		out = append(out, row{in, p.Parse(in)})
	}
	e := json.NewEncoder(os.Stdout)
	e.SetIndent("", " ")
	e.Encode(out)
}
