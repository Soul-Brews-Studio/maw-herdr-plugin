package main

import (
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestObservedActivitySuppressesOnlyNewProjection(t *testing.T) {
	var f observedFeed
	now := time.Unix(1000, 0)
	roster := observedRoster("working")
	name := strings.TrimSuffix(roster[0].Windows[0].Name, "-oracle")
	if !f.markActivity(name, now) {
		t.Fatal("mark")
	}
	f.observe(roster, now.Add(59999*time.Millisecond))
	if events, _ := f.read(0, now.Add(59999*time.Millisecond)); len(events) != 0 {
		t.Fatal(events)
	}
	f.observe(roster, now.Add(time.Minute))
	if events, _ := f.read(0, now.Add(time.Minute)); len(events) != 1 {
		t.Fatal(events)
	}
}
func TestObservedActivityBounds(t *testing.T) {
	var f observedFeed
	now := time.Now()
	if f.markActivity(" ", now) || f.markActivity(strings.Repeat("x", 1025), now) {
		t.Fatal("invalid")
	}
	for i := 0; i < 1000; i++ {
		if !f.markActivity(strconv.Itoa(i), now) {
			t.Fatal(i)
		}
	}
	if f.markActivity("overflow", now) {
		t.Fatal("unbounded")
	}
	if !f.markActivity("0", now) || !f.markActivity("new", now.Add(time.Minute)) {
		t.Fatal("refresh/expiry")
	}
}
