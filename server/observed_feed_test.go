package main

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"
)

func observedRoster(state string) []Session {
	return []Session{{Name: "main", Windows: []Window{{Index: 1, Name: "alpha", Agent: "codex", Status: state}, {Index: 2, Name: "shell", Status: "working"}}}}
}
func TestObservedFeedTransitionsReplayHeartbeatAndExpiry(t *testing.T) {
	var feed observedFeed
	now := time.Unix(1700000000, 0)
	feed.observe(observedRoster("working"), now)
	events, cursor := feed.read(0, now)
	if len(events) != 1 || events[0].Event != "PreToolUse" || events[0].Source != "herdr-agent-status" || events[0].Target != "main:1" || events[0].SessionID != "" {
		t.Fatal(events)
	}
	feed.observe(observedRoster("working"), now.Add(time.Second))
	if e, _ := feed.read(cursor, now.Add(time.Second)); len(e) != 0 {
		t.Fatal("duplicate", e)
	}
	feed.observe(observedRoster("working"), now.Add(10*time.Second))
	if e, _ := feed.read(cursor, now.Add(10*time.Second)); len(e) != 1 {
		t.Fatal("heartbeat", e)
	}
	for i, state := range []string{"blocked", "done", "idle"} {
		feed.observe(observedRoster(state), now.Add(time.Duration(11+i)*time.Second))
	}
	events, cursor = feed.read(0, now.Add(14*time.Second))
	if len(events) != 5 {
		t.Fatal(events)
	}
	for _, event := range events[2:] {
		if event.Event != "Stop" {
			t.Fatal(event)
		}
	}
	if e, _ := feed.read(cursor, now.Add(14*time.Second)); len(e) != 0 {
		t.Fatal(e)
	}
	if e, _ := feed.read(0, now.Add(74*time.Second)); len(e) != 0 {
		t.Fatal("expired history", e)
	}
	feed.observe(observedRoster("unknown"), now.Add(75*time.Second))
	if len(feed.tracked) != 0 {
		t.Fatal("unknown retained")
	}
}
func TestObservedFeedSkipsAmbiguousAndWrongResolverTarget(t *testing.T) {
	for _, windows := range [][]Window{
		{{Index: 1, Name: "alpha", Agent: "codex", Status: "working"}, {Index: 2, Name: "ALPHA", Status: "idle"}},
		{{Index: 1, Name: "alpha", Agent: "codex", Status: "working"}, {Index: 2, Name: "alpha-oracle", Status: "idle"}},
		{{Index: 1, Name: "alpha", Agent: "codex", Status: "unknown"}},
	} {
		var feed observedFeed
		now := time.Now()
		feed.observe([]Session{{Name: "main", Windows: windows}}, now)
		events, _ := feed.read(0, now)
		if len(events) != 0 {
			t.Fatal(events)
		}
	}
	var feed observedFeed
	now := time.Now()
	sessions := observedRoster("working")
	sessions[0].Name = "repo-wt-2-other"
	feed.observe(sessions, now)
	if events, _ := feed.read(0, now); len(events) != 0 {
		t.Fatal("worktree misroute", events)
	}
}
func TestObservedFeedBoundedAndShared(t *testing.T) {
	var feed observedFeed
	now := time.Now()
	sessions := []Session{{Name: "main"}}
	for i := 0; i < 1100; i++ {
		sessions[0].Windows = append(sessions[0].Windows, Window{Index: i, Name: fmt.Sprintf("agent%d", i), Agent: "codex", Status: "working"})
	}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); feed.observe(sessions, now) }()
	}
	wg.Wait()
	events, cursor := feed.read(0, now)
	if len(events) != 100 || cursor != 1000 || len(feed.tracked) != 1000 {
		t.Fatal(len(events), cursor, len(feed.tracked))
	}
	feed.observe(nil, now)
	if len(feed.tracked) != 0 {
		t.Fatal("departed tracked")
	}
}

type observedWSBackend struct{ fakeBackend }

func (*observedWSBackend) Sessions(context.Context) ([]Session, error) {
	return observedRoster("working"), nil
}
func TestObservedFeedSharedWebsocketReplay(t *testing.T) {
	f := newWSFixture(t, &observedWSBackend{}, time.Hour)
	first := f.connect(t)
	for _, kind := range []string{"sessions", "recent", "feed-history", "feed"} {
		if frame := readWS(t, first); frame["type"] != kind {
			t.Fatal(frame)
		}
	}
	second := f.connect(t)
	for _, kind := range []string{"sessions", "recent"} {
		if frame := readWS(t, second); frame["type"] != kind {
			t.Fatal(frame)
		}
	}
	history := readWS(t, second)
	if history["type"] != "feed-history" || len(history["events"].([]any)) != 1 {
		t.Fatal(history)
	}

	// A barrier proves connecting another client did not duplicate live projection.
	sendWS(t, second, map[string]any{"type": "unsupported"})
	if frame := readWS(t, second); frame["type"] != "error" {
		t.Fatal("duplicate livefeed", frame)
	}
}

func TestObservedFeedPurgesUnsafeReplay(t *testing.T) {
	for _, change := range []func([]Session) []Session{
		func(s []Session) []Session {
			s[0].Windows = append(s[0].Windows, Window{Index: 3, Name: "ALPHA"})
			return s
		},
		func(s []Session) []Session { s[0].Windows[0].Agent = ""; return s },
		func(s []Session) []Session { s[0].Windows[0].Status = "unknown"; return s },
		func([]Session) []Session { return nil },
	} {
		var feed observedFeed
		now := time.Now()
		feed.observe(observedRoster("working"), now)
		feed.observe(change(observedRoster("working")), now.Add(time.Second))
		if events, _ := feed.read(0, now.Add(time.Second)); len(events) != 0 {
			t.Fatal("unsafe replay retained", events)
		}
	}
}

type orderedRosterBackend struct {
	fakeBackend
	reads   int
	entered chan int
	release chan struct{}
}

func (b *orderedRosterBackend) Sessions(ctx context.Context) ([]Session, error) {
	b.mu.Lock()
	b.reads++
	read := b.reads
	b.mu.Unlock()
	b.entered <- read
	if read == 1 {
		select {
		case <-b.release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		return observedRoster("working"), nil
	}
	return observedRoster("blocked"), nil
}
func TestObservedRosterReadCannotOvertakeOlderSnapshot(t *testing.T) {
	b := &orderedRosterBackend{entered: make(chan int, 2), release: make(chan struct{})}
	s, err := NewServer(Config{Token: testToken}, b)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	done := make(chan error, 2)
	go func() { _, err := s.observeSessions(context.Background()); done <- err }()
	if read := <-b.entered; read != 1 {
		t.Fatal(read)
	}
	go func() { _, err := s.observeSessions(context.Background()); done <- err }()
	select {
	case read := <-b.entered:
		t.Fatal("second read overtook first", read)
	case <-time.After(30 * time.Millisecond):
	}
	close(b.release)
	for i := 0; i < 2; i++ {
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(time.Second):
			t.Fatal("roster lane stalled")
		}
	}
	events, _ := s.observed.read(0, time.Now())
	if len(events) != 2 || events[0].ObservedState != "working" || events[1].ObservedState != "blocked" {
		t.Fatal("reversed observation", events)
	}
}

type swappedRosterBackend struct {
	fakeBackend
	swapped bool
}

func (b *swappedRosterBackend) Sessions(context.Context) ([]Session, error) {
	windows := []Window{{Index: 1, Name: "alpha", Agent: "codex", Status: "working"}, {Index: 2, Name: "beta", Agent: "codex", Status: "blocked"}}
	if b.swapped {
		windows[0].Name, windows[1].Name = windows[1].Name, windows[0].Name
	}
	return []Session{{Name: "main", Windows: windows}}, nil
}
func TestObservedSnapshotKeepsEventsWithMatchingRoster(t *testing.T) {
	b := &swappedRosterBackend{}
	s, err := NewServer(Config{Token: testToken}, b)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	first, err := s.observeSessions(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	b.swapped = true
	second, err := s.observeSessions(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if first.cursor >= second.cursor || observedIdentity(first.sessions) == observedIdentity(second.sessions) {
		t.Fatal("swap missing")
	}
	for _, snapshot := range []observedSnapshot{first, second} {
		names := map[string]string{}
		for _, session := range snapshot.sessions {
			for _, window := range session.Windows {
				names[session.Name+":"+fmt.Sprint(window.Index)] = window.Name
			}
		}
		for _, event := range snapshot.events {
			if names[event.Target] != event.Oracle {
				t.Fatal("event drained against mismatched snapshot", event, names)
			}
		}
	}
	if len(first.events) != 2 || first.events[0].Oracle != "alpha" {
		t.Fatal("first snapshot mutated", first.events)
	}
}

func TestObservedIdentityChangesIgnoreStatusAndOrder(t *testing.T) {
	sessions := observedRoster("working")
	identity := observedIdentity(sessions)
	sessions[0].Windows[0].Status = "blocked"
	if observedIdentity(sessions) != identity {
		t.Fatal("status transition delayed as identity")
	}
	sessions[0].Windows[0], sessions[0].Windows[1] = sessions[0].Windows[1], sessions[0].Windows[0]
	if observedIdentity(sessions) != identity {
		t.Fatal("roster reorder changes identity")
	}
	sessions[0].Windows[1].Name = "renamed"
	if observedIdentity(sessions) == identity {
		t.Fatal("rename must defer until next poll")
	}
}
