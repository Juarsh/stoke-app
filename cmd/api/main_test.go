package main

import "testing"

func TestStubGuard(t *testing.T) {
	for _, c := range []struct {
		mode, env string
		ok        bool
	}{{"stub", "", false}, {"stub", "prod", false}, {"stub", "dev", true}, {"stub", "test", true}, {"off", "", true}, {"", "prod", true}} {
		if err := checkStubGuard(c.mode, c.env); (err == nil) != c.ok {
			t.Errorf("%+v: %v", c, err)
		}
	}
}
