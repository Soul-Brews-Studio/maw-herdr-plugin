package main

import (
	"context"
	"encoding/json"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type observedEvent struct {
	Timestamp     string `json:"timestamp"`
	TS            int64  `json:"ts"`
	Oracle        string `json:"oracle"`
	Project       string `json:"project"`
	SessionID     string `json:"sessionId"`
	Host          string `json:"host"`
	Source        string `json:"source"`
	ObservedState string `json:"observedState"`
	Target        string `json:"target"`
	Event         string `json:"event"`
	Message       string `json:"message"`
	sequence      uint64
}
type observedStatus struct {
	state string
	name  string
	last  time.Time
}
type observedFeed struct {
	mu           sync.Mutex
	sequence     uint64
	events       []observedEvent
	tracked      map[string]observedStatus
	realActivity map[string]time.Time
}

var worktreeProject = regexp.MustCompile(`[.-]wt-(?:[0-9]+-)?(.+)$`)

func uniqueObservedTarget(names map[string][]string, project, oracle, target string) bool {
	desired := strings.ToLower(oracle)
	if match := worktreeProject.FindStringSubmatch(project); match != nil {
		desired = strings.ToLower(oracle + "-" + match[1])
	} else {
		preferred := desired
		if !strings.HasSuffix(preferred, "-oracle") {
			preferred += "-oracle"
		}
		if len(names[preferred]) > 0 {
			desired = preferred
		}
	}
	matches := names[desired]
	return len(matches) == 1 && matches[0] == target
}
func (f *observedFeed) prune(now time.Time) {
	first := 0
	for first < len(f.events) && now.Sub(time.UnixMilli(f.events[first].TS)) >= 60*time.Second {
		first++
	}
	if first > 0 {
		f.events = append([]observedEvent(nil), f.events[first:]...)
	}
}
func (f *observedFeed) observe(sessions []Session, now time.Time) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.prune(now)
	names := map[string][]string{}
	for _, s := range sessions {
		for _, w := range s.Windows {
			name := strings.ToLower(w.Name)
			if len(names[name]) < 2 {
				names[name] = append(names[name], s.Name+":"+strconv.Itoa(w.Index))
			}
		}
	}
	next := map[string]observedStatus{}
	for _, s := range sessions {
		for _, w := range s.Windows {
			if len(next) >= 1000 || w.Name == "" || len(w.Name) > 1024 || len(s.Name) > 1024 {
				continue
			}
			target := s.Name + ":" + strconv.Itoa(w.Index)
			if strings.TrimSpace(w.Agent) == "" || !uniqueObservedTarget(names, s.Name, w.Name, target) {
				continue
			}
			event := "Stop"
			switch w.Status {
			case "working":
				event = "PreToolUse"
			case "blocked", "done", "idle":
			default:
				continue
			}
			old, exists := f.tracked[target]
			next[target] = old
			if exists && old.name == w.Name && old.state == w.Status && (w.Status != "working" || now.Sub(old.last) < 10*time.Second) {
				continue
			}
			if seen, ok := f.realActivity[strings.TrimSuffix(w.Name, "-oracle")]; ok && now.Sub(seen) < time.Minute {
				next[target] = observedStatus{state: w.Status, name: w.Name, last: old.last}
				continue
			}
			f.sequence++
			f.events = append(f.events, observedEvent{Timestamp: now.UTC().Format("2006-01-02T15:04:05.000Z"), TS: now.UnixMilli(), Oracle: w.Name, Project: s.Name, Host: "local", Source: "herdr-agent-status", ObservedState: w.Status, Target: target, Event: event, Message: "Herdr observed " + w.Status + "; status projection, not a tool hook", sequence: f.sequence})
			if len(f.events) > 100 {
				f.events = append([]observedEvent(nil), f.events[len(f.events)-100:]...)
			}
			next[target] = observedStatus{state: w.Status, name: w.Name, last: now}
		}
	}
	retained := f.events[:0]
	for _, event := range f.events {
		if _, ok := next[event.Target]; ok && uniqueObservedTarget(names, event.Project, event.Oracle, event.Target) {
			retained = append(retained, event)
		}
	}
	f.events = retained
	f.tracked = next
}
func (f *observedFeed) read(cursor uint64, now time.Time) ([]observedEvent, uint64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.prune(now)
	events := []observedEvent{}
	for _, event := range f.events {
		if event.sequence > cursor {
			events = append(events, event)
		}
	}
	return events, f.sequence
}

// Serialize the authoritative read with its projection: a delayed old snapshot
// must never overtake another client and synthesize a newer false busy event.
type observedSnapshot struct {
	sessions []Session
	events   []observedEvent
	cursor   uint64
}

func (s *Server) observeSessions(ctx context.Context) (observedSnapshot, error) {
	select {
	case s.observedRosterGate <- struct{}{}:
	case <-ctx.Done():
		return observedSnapshot{}, ctx.Err()
	}
	defer func() { <-s.observedRosterGate }()
	sessions, err := s.backend.Sessions(ctx)
	if err != nil {
		return observedSnapshot{}, err
	}
	s.observed.observe(sessions, time.Now())
	events, cursor := s.observed.read(0, time.Now())
	// Copy the matching event generation before releasing the roster lane.
	// Socket writes must never drain a newer generation against this roster.
	return observedSnapshot{sessions: sessions, events: events, cursor: cursor}, nil
}

func observedIdentity(sessions []Session) string {
	rows := []string{}
	for _, session := range sessions {
		for _, window := range session.Windows {
			row, _ := json.Marshal([]string{session.Name, strconv.Itoa(window.Index), window.Name, window.Agent})
			rows = append(rows, string(row))
		}
	}
	sort.Strings(rows)
	encoded, _ := json.Marshal(rows)
	return string(encoded)
}
