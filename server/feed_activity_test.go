package main

import (
	"strings"
	"testing"
	"time"
)

func TestHTTPFeedActivity(t *testing.T) {
	s, _ := testServer(t)
	for _, body := range []string{`{`, `null`, `[]`, `{}`, `{"oracle":12}`, `{"oracle":" "}`} {
		if w := request(s, "POST", "/api/feed", body, nil); w.Code != 200 {
			t.Fatal(w.Code, w.Body)
		}
	}
	w := request(s, "POST", "/api/feed", `{"oracle":"demo","event":"invented","text":"not logged"}`, nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	if _, ok := s.observed.realActivity["demo"]; !ok {
		t.Fatal("not marked")
	}
	if s.deliveryHistory.snapshot(-1).Total != 0 {
		t.Fatal("arbitrary history injection")
	}
	if w := request(s, "POST", "/api/feed", strings.Repeat("x", 65537), nil); w.Code != 400 {
		t.Fatal(w.Code)
	}
	if w := request(s, "POST", "/api/feed", `{"oracle":"`+strings.Repeat("x", 1025)+`"}`, nil); w.Code != 400 {
		t.Fatal(w.Code)
	}
	s.observed.observe(observedRoster("working"), time.Now())
}
