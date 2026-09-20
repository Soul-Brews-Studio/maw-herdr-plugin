package main

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

type wakeFake struct {
	fakeBackend
	wakes int
}

func (b *wakeFake) Wake(context.Context, string) (string, error) { b.wakes++; return "ready", nil }
func TestWakeHTTPAndSocket(t *testing.T) {
	b := &wakeFake{}
	f := newWSFixture(t, b, time.Hour)
	w := request(f.server, "POST", "/api/wake", `{"target":"default/w1:1"}`, nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"state":"ready"`) || b.wakes != 1 {
		t.Fatal(w.Code, w.Body, b.wakes)
	}
	w = request(f.server, "POST", "/api/wake", `{"target":"default/w1:1","task":"work"}`, nil)
	if w.Code != 501 || b.wakes != 1 {
		t.Fatal(w.Code, w.Body)
	}
	conn := f.connect(t)
	initialWS(t, conn)
	sendWS(t, conn, map[string]any{"type": "wake", "target": "default/w1:1", "command": ""})
	if frame := readWS(t, conn); frame["type"] != "action-ok" || frame["action"] != "wake" || frame["target"] != "default/w1:1" {
		t.Fatal(frame)
	}
	sendWS(t, conn, map[string]any{"type": "wake", "target": "default/w1:1", "command": "touch nope"})
	if frame := readWS(t, conn); frame["type"] != "error" {
		t.Fatal(frame)
	}
	if b.wakes != 2 {
		t.Fatal("command executed", b.wakes)
	}
}

func TestWakeBackendExactPaneAndReadiness(t *testing.T) {
	b, calls, _ := testBackend(t)
	old := b.run
	response := `{"result":{"type":"agent_started","agent":{"pane_id":"wD:p9","agent":"claude","interactive_ready":true},"argv":[]}}`
	b.run = func(ctx context.Context, args ...string) ([]byte, error) {
		if len(args) > 3 && args[2] == "agent" && args[3] == "start" {
			*calls = append(*calls, append([]string{}, args...))
			return []byte(response), nil
		}
		return old(ctx, args...)
	}
	state, err := b.Wake(context.Background(), "bWFpbg/d0Q:4")
	if err != nil || state != "already-awake" || len(*calls) != 2 {
		t.Fatal(state, err, *calls)
	}
	state, err = b.Wake(context.Background(), "bWFpbg/d0Q:9")
	if err != nil || state != "ready" {
		t.Fatal(state, err)
	}
	argv := (*calls)[len(*calls)-1]
	if len(argv) != 11 || !strings.HasPrefix(argv[4], "maw-") || len(argv[4]) != 20 || !reflect.DeepEqual(argv[:4], []string{"--session", "main", "agent", "start"}) || !reflect.DeepEqual(argv[5:], []string{"--kind", "claude", "--pane", "wD:p9", "--timeout", "8000"}) {
		t.Fatal(argv)
	}
	for _, bad := range []string{`{}`, `{"error":"private"}`, `{"type":"agent_started","agent":{"pane_id":"other","agent":"claude","interactive_ready":true},"argv":[]}`, `{"type":"agent_started","agent":{"pane_id":"wD:p9","agent":"claude","interactive_ready":false},"argv":[]}`, `{"type":"agent_started","agent":{"pane_id":"wD:p9","agent":"claude","interactive_ready":true,"launch_pending":true},"argv":[]}`} {
		response = bad
		if _, err = b.Wake(context.Background(), "bWFpbg/d0Q:9"); err == nil {
			t.Fatal("false readiness", bad)
		}
	}
	if _, err = b.Wake(context.Background(), "gone"); err != ErrTargetNotFound {
		t.Fatal(err)
	}
}

func TestWakeEngineConfiguration(t *testing.T) {
	for _, kind := range []string{"claude", "codex", "muse"} {
		backend := NewHerdrBackend("herdr")
		server, err := NewServer(Config{Token: testToken, WakeEngine: kind}, backend)
		if err != nil {
			t.Fatal(err)
		}
		server.Close()
		if backend.wakeEngine != kind {
			t.Fatal(backend.wakeEngine)
		}
	}
	for _, kind := range []string{"custom-kind_2", "--option", "sh -c evil", "x;y", "/bin/sh", strings.Repeat("x", 65)} {
		if _, err := NewServer(Config{Token: testToken, WakeEngine: kind}, NewHerdrBackend("herdr")); err == nil {
			t.Fatal("unsafe kind accepted", kind)
		}
	}
}

func TestWakeCapacityRejectsBeforeRosterAndReleases(t *testing.T) {
	b := NewHerdrBackend("herdr")
	entered := make(chan struct{}, 8)
	b.run = func(ctx context.Context, _ ...string) ([]byte, error) {
		entered <- struct{}{}
		<-ctx.Done()
		return nil, ctx.Err()
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{}, 8)
	for i := 0; i < 8; i++ {
		go func() { defer func() { done <- struct{}{} }(); _, _ = b.Wake(ctx, "target") }()
	}
	for i := 0; i < 8; i++ {
		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("capacity not available")
		}
	}
	if _, err := b.Wake(context.Background(), "target"); !errors.Is(err, ErrWakeBusy) {
		t.Fatal("busy wake not rejected", err)
	}
	cancel()
	for i := 0; i < 8; i++ {
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("wake leaked")
		}
	}
	if len(b.wakeSlots) != 0 {
		t.Fatal("capacity not released")
	}
}
