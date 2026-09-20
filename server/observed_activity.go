package main

import (
	"strings"
	"time"
)

// Operator-authenticated activity only suppresses synthetic status events.
// It never appends an arbitrary payload to either feed.
func (f *observedFeed) markActivity(oracle string, now time.Time) bool {
	if strings.TrimSpace(oracle) == "" || len(oracle) > 1024 {
		return false
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.realActivity == nil {
		f.realActivity = map[string]time.Time{}
	}
	for key, seen := range f.realActivity {
		if now.Sub(seen) >= time.Minute {
			delete(f.realActivity, key)
		}
	}
	if _, exists := f.realActivity[oracle]; !exists && len(f.realActivity) >= 1000 {
		return false
	}
	f.realActivity[oracle] = now
	return true
}
