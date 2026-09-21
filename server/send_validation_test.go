package main

import (
	"encoding/json"
	"testing"
)

func TestSendEmptyTargetLegacyFailure(t *testing.T) {
	s, b := testServer(t)
	for _, target := range []string{"", " ", "\t\n", "\u2003", "\u0085"} {
		raw, _ := json.Marshal(map[string]string{"target": target, "text": "undeliverable"})
		w := request(s, "POST", "/api/send", string(raw), nil)
		var result map[string]any
		json.Unmarshal(w.Body.Bytes(), &result)
		if w.Code != 400 || result["error"] != "empty-target" || result["state"] != "failed" || result["ok"] != false {
			t.Fatal(w.Code, w.Body)
		}
	}
	if b.sends != 0 {
		t.Fatal("invalid target dispatched")
	}
	if s.deliveryHistory.snapshot(-1).Total != 5 {
		t.Fatal("missing failure history")
	}
}
