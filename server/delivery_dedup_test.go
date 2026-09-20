package main

import (
	"fmt"
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
