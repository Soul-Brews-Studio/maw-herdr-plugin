package main

import (
	"net/http"
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

func TestHTTPActivitySuppressesWebsocketProjection(t *testing.T) {
	f := newWSFixture(t, &observedWSBackend{}, time.Hour)
	req, err := http.NewRequest("POST", f.http.URL+"/api/feed", strings.NewReader(`{"oracle":"alpha","event":"not-injected"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+testToken)
	res, err := f.http.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatal(res.StatusCode)
	}
	conn := f.connect(t)
	for _, kind := range []string{"sessions", "recent", "teams"} {
		if frame := readWS(t, conn); frame["type"] != kind {
			t.Fatal(frame)
		}
	}
	history := readWS(t, conn)
	if history["type"] != "feed-history" || len(history["events"].([]any)) != 0 {
		t.Fatal(history)
	}
	sendWS(t, conn, map[string]any{"type": "unsupported"})
	if frame := readWS(t, conn); frame["type"] != "error" {
		t.Fatal("unexpected synthetic or injected event", frame)
	}
	if f.server.deliveryHistory.snapshot(-1).Total != 0 {
		t.Fatal("injected delivery history")
	}
}
