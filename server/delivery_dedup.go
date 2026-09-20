package main

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"
)

// deliveryDedup is process-local. A queued duplicate is an in-flight receipt,
// not proof that the original operation succeeded or the agent consumed it.
type deliveryDedup struct {
	mu      sync.Mutex
	records map[[32]byte]*deliveryClaim
}
type deliveryClaim struct {
	state string
	seen  time.Time
}

var errDeliveryDedupFull = errors.New("delivery deduplication capacity reached")

func deliveryKey(source, target, logical, payload string) ([32]byte, bool) {
	source, target, logical = strings.TrimSpace(source), strings.TrimSpace(target), strings.TrimSpace(logical)
	if source == "" || target == "" || logical == "" {
		return [32]byte{}, false
	}
	raw, _ := json.Marshal([]string{source, target, logical, payload})
	return sha256.Sum256(raw), true
}

func (d *deliveryDedup) claim(key [32]byte, now time.Time) (*deliveryClaim, string, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.records == nil {
		d.records = make(map[[32]byte]*deliveryClaim)
	}
	for k, r := range d.records {
		if r.state != "" && now.Sub(r.seen) > 24*time.Hour {
			delete(d.records, k)
		}
	}
	if r := d.records[key]; r != nil {
		state := r.state
		if state == "" {
			state = "queued"
		}
		return nil, state, nil
	}
	if len(d.records) >= 2048 {
		return nil, "", errDeliveryDedupFull
	}
	owner := &deliveryClaim{seen: now}
	d.records[key] = owner
	return owner, "", nil
}
func (d *deliveryDedup) complete(key [32]byte, owner *deliveryClaim, state string, now time.Time) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if owner != nil && d.records[key] == owner {
		owner.state = state
		owner.seen = now
	}
}
func (d *deliveryDedup) cancel(key [32]byte, owner *deliveryClaim) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if owner != nil && d.records[key] == owner && owner.state == "" {
		delete(d.records, key)
	}
}
