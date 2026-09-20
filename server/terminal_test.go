package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type terminalFake struct {
	fakeBackend
	received chan terminalInput
	stopped  chan struct{}
}

func (b *terminalFake) Terminal(ctx context.Context, target string, cols, rows int, input <-chan terminalInput, output func([]byte) error) error {
	defer close(b.stopped)
	if err := output([]byte("\x1b[2Jherdr terminal")); err != nil {
		return err
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case message := <-input:
			b.received <- message
		}
	}
}
func ptyTicket(t *testing.T, f *wsFixture) string {
	t.Helper()
	req, _ := http.NewRequest("POST", f.http.URL+"/api/auth/ws-ticket", strings.NewReader(`{"path":"/ws/pty"}`))
	req.Header.Set("Origin", dashboardOrigin)
	req.Header.Set("Authorization", "Bearer "+testToken)
	req.Header.Set("Content-Type", "application/json")
	res, err := f.http.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var value map[string]string
	if json.NewDecoder(res.Body).Decode(&value) != nil || res.StatusCode != 200 {
		t.Fatal("ticket failed")
	}
	return value["ticket"]
}
func TestPTYTicketsArePathBound(t *testing.T) {
	f := newWSFixture(t, &fakeBackend{}, time.Hour)
	for _, tc := range []struct{ ticket, path string }{{f.ticket(t), "/ws/pty"}, {ptyTicket(t, f), "/ws"}} {
		conn, res, err := f.dial(t, tc.path, dashboardOrigin, []string{protocol, tc.ticket})
		if conn != nil {
			conn.CloseNow()
		}
		if err == nil || res == nil || res.StatusCode != 401 {
			t.Fatal("cross-path ticket accepted", err, res)
		}
	}
}
func TestPTYBinaryInputResizeAndShutdown(t *testing.T) {
	b := &terminalFake{received: make(chan terminalInput, 2), stopped: make(chan struct{})}
	f := newWSFixture(t, b, time.Hour)
	ticket := ptyTicket(t, f)
	conn, _, err := f.dial(t, "/ws/pty", dashboardOrigin, []string{protocol, ticket})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	sendWS(t, conn, map[string]any{"type": "attach", "target": "default/w1:1", "cols": 80, "rows": 24})
	if frame := readWS(t, conn); frame["type"] != "attached" {
		t.Fatal(frame)
	}
	ctx, done := context.WithTimeout(context.Background(), 2*time.Second)
	defer done()
	kind, data, err := conn.Read(ctx)
	if err != nil || kind != websocket.MessageBinary || string(data) != "\x1b[2Jherdr terminal" {
		t.Fatal(kind, string(data), err)
	}
	if err = conn.Write(ctx, websocket.MessageBinary, []byte{0, 3, 255}); err != nil {
		t.Fatal(err)
	}
	sendWS(t, conn, map[string]any{"type": "resize", "cols": 90, "rows": 30})
	for i := 0; i < 2; i++ {
		select {
		case message := <-b.received:
			if i == 0 && (message.Type != "terminal.input" || message.Bytes != base64.StdEncoding.EncodeToString([]byte{0, 3, 255})) {
				t.Fatal(message)
			}
			if i == 1 && (message.Type != "terminal.resize" || message.Cols != 90 || message.Rows != 30) {
				t.Fatal(message)
			}
		case <-ctx.Done():
			t.Fatal("input missing")
		}
	}
	replay, res, err := f.dial(t, "/ws/pty", dashboardOrigin, []string{protocol, ticket})
	if replay != nil {
		replay.CloseNow()
	}
	if err == nil || res.StatusCode != 401 {
		t.Fatal("replay accepted")
	}
	f.server.Close()
	select {
	case <-b.stopped:
	case <-ctx.Done():
		t.Fatal("terminal did not stop")
	}
}
func TestPTYRejectsInvalidAttach(t *testing.T) {
	for _, value := range []any{map[string]any{"type": "resize", "cols": 80, "rows": 24}, map[string]any{"type": "attach", "target": "x", "cols": 501, "rows": 24}, map[string]any{"type": "attach", "target": "x", "cols": 80, "rows": 0}, map[string]any{"type": "attach", "target": "x", "cols": 80, "rows": 24, "takeover": true}} {
		b := &terminalFake{received: make(chan terminalInput, 2), stopped: make(chan struct{})}
		f := newWSFixture(t, b, time.Hour)
		conn, _, err := f.dial(t, "/ws/pty", dashboardOrigin, []string{protocol, ptyTicket(t, f)})
		if err != nil {
			t.Fatal(err)
		}
		sendWS(t, conn, value)
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_, _, err = conn.Read(ctx)
		cancel()
		conn.CloseNow()
		if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
			t.Fatal(err)
		}
	}
}
func TestTerminalProcessFramesAndCleanup(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "herdr")
	log := filepath.Join(dir, "input")
	script := `#!/bin/sh
printf '%s\n' '{"type":"terminal.frame","encoding":"ansi","bytes":"aGVsbG8="}'
cat > '` + log + `'
`

	if err := os.WriteFile(binary, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	b := NewHerdrBackend(binary)
	b.run = func(_ context.Context, args ...string) ([]byte, error) {
		if args[0] == "session" {
			return []byte(`{"sessions":[{"name":"test","running":true}]}`), nil
		}
		return []byte(`{"protocol":22,"workspaces":[{"workspace_id":"w1"}],"panes":[{"pane_id":"w1:p1","workspace_id":"w1","focused":false,"agent_status":"idle"}]}`), nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	input := make(chan terminalInput, 1)
	input <- terminalInput{Type: "terminal.input", Bytes: "eA=="}
	done := make(chan error, 1)
	frames := make(chan []byte, 1)
	go func() {
		done <- b.Terminal(ctx, "dGVzdA/dzE:1", 80, 24, input, func(data []byte) error { frames <- data; return nil })
	}()
	select {
	case data := <-frames:
		if string(data) != "hello" {
			t.Fatal(string(data))
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no frame")
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		data, _ := os.ReadFile(log)
		if strings.Contains(string(data), `"bytes":"eA=="`) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("input not forwarded")
		}
		time.Sleep(time.Millisecond * 10)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("process cleanup stuck")
	}
}

func TestTerminalBoundsInheritedPipesAndStderr(t *testing.T) {
	for _, script := range []string{"sleep 60 &\nexit 0\n", "head -c 65537 /dev/zero >&2\nsleep 60\n"} {
		dir := t.TempDir()
		binary := filepath.Join(dir, "herdr")
		if err := os.WriteFile(binary, []byte("#!/bin/sh\n"+script), 0700); err != nil {
			t.Fatal(err)
		}
		b := NewHerdrBackend(binary)
		b.run = func(_ context.Context, args ...string) ([]byte, error) {
			if args[0] == "session" {
				return []byte(`{"sessions":[{"name":"test","running":true}]}`), nil
			}
			return []byte(`{"protocol":22,"workspaces":[{"workspace_id":"w1"}],"panes":[{"pane_id":"w1:p1","workspace_id":"w1","focused":false,"agent_status":"idle"}]}`), nil
		}
		ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
		start := time.Now()
		err := b.Terminal(ctx, "dGVzdA/dzE:1", 80, 24, make(chan terminalInput), func([]byte) error { return nil })
		cancel()
		if err == nil || time.Since(start) > 3*time.Second {
			t.Fatalf("unbounded terminal cleanup: %v after %s", err, time.Since(start))
		}
	}
}

type earlyInputTerminal struct{ fakeBackend }

func (*earlyInputTerminal) Terminal(ctx context.Context, _ string, _, _ int, input <-chan terminalInput, output func([]byte) error) error {
	select {
	case command := <-input:
		data, err := base64.StdEncoding.DecodeString(command.Bytes)
		if err != nil {
			return err
		}
		if err = output(data); err != nil {
			return err
		}
	case <-ctx.Done():
		return ctx.Err()
	}
	<-ctx.Done()
	return ctx.Err()
}
func TestPTYAcceptsInputBeforeFirstFrame(t *testing.T) {
	f := newWSFixture(t, &earlyInputTerminal{}, time.Hour)
	conn, _, err := f.dial(t, "/ws/pty", dashboardOrigin, []string{protocol, ptyTicket(t, f)})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	sendWS(t, conn, map[string]any{"type": "attach", "target": "default/w1:1", "cols": 80, "rows": 24})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err = conn.Write(ctx, websocket.MessageBinary, []byte("early input")); err != nil {
		t.Fatal(err)
	}
	if frame := readWS(t, conn); frame["type"] != "attached" {
		t.Fatal(frame)
	}
	kind, data, err := conn.Read(ctx)
	if err != nil || kind != websocket.MessageBinary || string(data) != "early input" {
		t.Fatal(kind, string(data), err)
	}
}
