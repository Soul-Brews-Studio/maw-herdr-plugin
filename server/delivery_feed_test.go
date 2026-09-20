package main

import (
	"strconv"
	"strings"
	"sync"
	"testing"
)

func TestDeliveryFeedBoundedSnapshot(t *testing.T) {
	var f deliveryFeed
	if got := f.snapshot(-1); got.Events == nil || got.ActiveOracles == nil || got.Total != 0 {
		t.Fatal(got)
	}
	for i := 0; i < 205; i++ {
		f.append(deliveryEvent{Timestamp: int64(i), Oracle: strconv.Itoa(i % 2), Text: strings.Repeat("x", 2001)})
	}
	got := f.snapshot(-1)
	if got.Total != 200 || got.Events[0].Timestamp != 5 || len(got.Events[0].Text) != 2002 {
		t.Fatal(got.Total)
	}
	if len(got.ActiveOracles) != 2 || got.ActiveOracles[0] != "1" {
		t.Fatal(got.ActiveOracles)
	}
	got.Events[0].Text = "changed"
	if f.snapshot(-1).Events[0].Text == "changed" {
		t.Fatal("snapshot aliases storage")
	}
	if f.snapshot(0).Total != 0 || f.snapshot(1).Events[0].Timestamp != 204 || f.snapshot(999).Total != 200 {
		t.Fatal("limit")
	}
	if deliveryTruncate(strings.Repeat("é", 1001), 2000) != strings.Repeat("é", 1001)+"…" {
		t.Fatal("legacy Unicode semantics")
	}
}
func TestDeliveryFeedConcurrent(t *testing.T) {
	var f deliveryFeed
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 30; j++ {
				f.append(deliveryEvent{Oracle: "a"})
				f.snapshot(10)
			}
		}()
	}
	wg.Wait()
	if f.snapshot(-1).Total != 200 {
		t.Fatal("capacity")
	}
}
