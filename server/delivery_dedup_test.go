package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestDeliveryDedupLifecycle(t *testing.T) {
	var d deliveryDedup
	now := time.Unix(1000, 0)
	key, ok := deliveryKey(" sender ", " target ", " 1 ", "message")
	if !ok {
		t.Fatal("key")
	}
	for _, parts := range [][4]string{{"other", "target", "1", "message"}, {"sender", "other", "1", "message"}, {"sender", "target", "2", "message"}, {"sender", "target", "1", "other"}} {
		different, _ := deliveryKey(parts[0], parts[1], parts[2], parts[3])
		if different == key {
			t.Fatal("key collision", parts)
		}
	}
	if _, ok := deliveryKey("sender", "target", "", "message"); ok {
		t.Fatal("missing timestamp deduped")
	}
	owner, dup, err := d.claim(key, now)
	if err != nil || owner == nil || dup != "" {
		t.Fatal(owner, dup, err)
	}
	_, dup, err = d.claim(key, now)
	if err != nil || dup != "queued" {
		t.Fatal(dup, err)
	}
	d.cancel(key, owner)
	next, _, _ := d.claim(key, now)
	d.cancel(key, owner)
	d.complete(key, owner, "wrong", now)
	d.complete(key, next, "accepted", now)
	_, dup, _ = d.claim(key, now.Add(24*time.Hour))
	if dup != "accepted" {
		t.Fatal(dup)
	}
	newer, dup, err := d.claim(key, now.Add(24*time.Hour+time.Second))
	if newer == nil || dup != "" || err != nil {
		t.Fatal(dup, err)
	}
}
func TestDeliveryDedupConcurrentAndBounded(t *testing.T) {
	var d deliveryDedup
	now := time.Now()
	key, _ := deliveryKey("s", "t", "1", "p")
	var owners atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			owner, _, err := d.claim(key, now)
			if err != nil {
				t.Error(err)
			}
			if owner != nil {
				owners.Add(1)
			}
		}()
	}
	wg.Wait()
	if owners.Load() != 1 {
		t.Fatal(owners.Load())
	}
	for i := 1; i < 2048; i++ {
		key, _ := deliveryKey("s", "t", fmt.Sprint(i+1), "p")
		if _, _, err := d.claim(key, now); err != nil {
			t.Fatal(err)
		}
	}
	overflow, _ := deliveryKey("s", "t", "overflow", "p")
	if _, _, err := d.claim(overflow, now.Add(48*time.Hour)); err != errDeliveryDedupFull {
		t.Fatal("in-flight claims evicted", err)
	}
}

func TestHTTPDeliveryDedup(t *testing.T) {
	s, b := testServer(t)
	headers := map[string]string{"X-Maw-Timestamp": "fixture-1", "X-Maw-From": "sender:node"}
	body := `{"target":"default/w1:1","text":"once"}`
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w := request(s, "POST", "/api/send", body, headers)
			if w.Code != 200 {
				t.Errorf("%d %s", w.Code, w.Body)
			}
		}()
	}
	wg.Wait()
	if b.sends != 1 {
		t.Fatal("duplicate dispatch", b.sends)
	}
	for i := 0; i < 2; i++ {
		if w := request(s, "POST", "/api/send", body, nil); w.Code != 200 {
			t.Fatal(w.Code)
		}
	}
	if b.sends != 3 {
		t.Fatal("untimestamped dispatch", b.sends)
	}
	headers["X-Maw-Timestamp"] = "fixture-2"
	if w := request(s, "POST", "/api/send", body, headers); w.Code != 200 {
		t.Fatal(w.Code)
	}
	history := request(s, "GET", "/api/feed", "", nil)
	var snapshot deliverySnapshot
	if err := json.Unmarshal(history.Body.Bytes(), &snapshot); err != nil {
		t.Fatal(err)
	}
	if history.Code != 200 || snapshot.Total != 11 {
		t.Fatal(history.Code, history.Body)
	}
	states := map[string]int{}
	for _, event := range snapshot.Events {
		states[event.State]++
	}
	if states["accepted"] != 4 || states["deduped"] != 7 {
		t.Fatal(states)
	}
	for _, query := range []string{"-1", "x", "", "1&limit=2", "18446744073709551616"} {
		if got := request(s, "GET", "/api/feed?limit="+query, "", nil); got.Code != 400 {
			t.Fatal(query, got.Code)
		}
	}
	if got := request(s, "GET", "/api/feed?limit=0", "", nil); got.Code != 200 || !strings.Contains(got.Body.String(), `"events":[]`) {
		t.Fatal(got.Body)
	}
	if b.sends != 4 {
		t.Fatal("new logical timestamp", b.sends)
	}
}
