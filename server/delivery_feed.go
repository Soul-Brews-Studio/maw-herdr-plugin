package main

import "sync"

// Delivery history is independent of the observed-status WebSocket projection.
type deliveryEvent struct {
	Timestamp int64  `json:"timestamp"`
	Kind      string `json:"kind"`
	Direction string `json:"direction"`
	State     string `json:"state"`
	Route     string `json:"route"`
	From      string `json:"from"`
	To        string `json:"to"`
	Target    string `json:"target"`
	Text      string `json:"text"`
	Oracle    string `json:"oracle"`
	Source    string `json:"source"`
	Error     string `json:"error,omitempty"`
}
type deliverySnapshot struct {
	Events        []deliveryEvent `json:"events"`
	Total         int             `json:"total"`
	ActiveOracles []string        `json:"active_oracles"`
}
type deliveryFeed struct {
	mu     sync.Mutex
	events []deliveryEvent
}

// Match legacy byte-length trigger and Unicode-scalar truncation.
func deliveryTruncate(value string, max int) string {
	if len(value) <= max {
		return value
	}
	chars := []rune(value)
	if len(chars) > max-1 {
		chars = chars[:max-1]
	}
	return string(chars) + "…"
}
func (f *deliveryFeed) append(event deliveryEvent) {
	event.Text = deliveryTruncate(event.Text, 2000)
	event.From = deliveryTruncate(event.From, 2000)
	event.To = deliveryTruncate(event.To, 2000)
	event.Error = deliveryTruncate(event.Error, 1000)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.events = append(f.events, event)
	if len(f.events) > 200 {
		copy(f.events, f.events[len(f.events)-200:])
		f.events = f.events[:200]
	}
}
func (f *deliveryFeed) snapshot(limit int) deliverySnapshot {
	f.mu.Lock()
	defer f.mu.Unlock()
	start := 0
	if limit >= 0 && limit < len(f.events) {
		start = len(f.events) - limit
	}
	result := deliverySnapshot{Events: append([]deliveryEvent{}, f.events[start:]...), ActiveOracles: []string{}}
	seen := map[string]bool{}
	for _, event := range result.Events {
		if !seen[event.Oracle] {
			seen[event.Oracle] = true
			result.ActiveOracles = append(result.ActiveOracles, event.Oracle)
		}
	}
	result.Total = len(result.Events)
	return result
}
