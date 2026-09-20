package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

const dashboardOrigin = "https://god.buildwithoracle.com"

type wsFixture struct {
	server *Server
	http   *httptest.Server
	done   chan struct{}
}

func newWSFixture(t *testing.T, backend Backend, interval time.Duration) *wsFixture {
	t.Helper()
	if interval == time.Hour {
		interval = 20 * time.Millisecond
	}
	s, err := NewServer(Config{Token: testToken, DataDir: t.TempDir(), PollInterval: interval}, backend)
	if err != nil {
		t.Fatal(err)
	}
	f := &wsFixture{server: s, done: make(chan struct{}, 64)}
	f.http = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.ServeHTTP(w, r)
		if r.URL.Path == "/ws" {
			f.done <- struct{}{}
		}
	}))
	t.Cleanup(func() { s.Close(); f.http.Close() })
	return f
}

func (f *wsFixture) ticket(t *testing.T) string {
	t.Helper()
	req, err := http.NewRequest("POST", f.http.URL+"/api/auth/ws-ticket", strings.NewReader(`{"path":"/ws"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+testToken)
	req.Header.Set("Origin", dashboardOrigin)
	req.Header.Set("Content-Type", "application/json")
	res, err := f.http.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var value map[string]string
	if err = json.NewDecoder(res.Body).Decode(&value); err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 || value["protocol"] != protocol || res.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("ticket response: %d %v", res.StatusCode, value)
	}
	return value["ticket"]
}

func (f *wsFixture) dial(t *testing.T, path, origin string, offers []string) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return websocket.Dial(ctx, "ws"+strings.TrimPrefix(f.http.URL, "http")+path, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": []string{origin}}, Subprotocols: offers})
}

func (f *wsFixture) connect(t *testing.T) *websocket.Conn {
	t.Helper()
	conn, res, err := f.dial(t, "/ws", dashboardOrigin, []string{protocol, f.ticket(t)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	if conn.Subprotocol() != protocol || res.Header.Get("Sec-WebSocket-Protocol") != protocol {
		t.Fatal("server must negotiate only maw.ws.v1, never the ticket")
	}
	return conn
}

func readWS(t *testing.T, conn *websocket.Conn) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	kind, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if kind != websocket.MessageText {
		t.Fatal("expected JSON text frame")
	}
	var frame map[string]any
	if err = json.Unmarshal(data, &frame); err != nil {
		t.Fatal(err)
	}
	return frame
}

func sendWS(t *testing.T, conn *websocket.Conn, value any) {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err = conn.Write(ctx, websocket.MessageText, data); err != nil {
		t.Fatal(err)
	}
}

func initialWS(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	frame := readWS(t, conn)
	if frame["type"] != "sessions" {
		t.Fatalf("sessions: %v", frame)
	}
	sessions := frame["sessions"].([]any)
	if len(sessions) != 1 || sessions[0].(map[string]any)["name"] != "default/w1" {
		t.Fatalf("roster: %v", frame)
	}
	window := sessions[0].(map[string]any)["windows"].([]any)[0].(map[string]any)
	if window["index"] != float64(1) || window["active"] != true {
		t.Fatalf("window: %v", window)
	}
	frame = readWS(t, conn)
	if frame["type"] != "recent" {
		t.Fatalf("recent: %v", frame)
	}
	agents := frame["agents"].([]any)
	if len(agents) < 1 || agents[0].(map[string]any)["target"] != "default/w1:1" {
		t.Fatalf("recent target: %v", frame)
	}
	if frame := readWS(t, conn); frame["type"] != "feed-history" {
		t.Fatal(frame)
	}
	if window["status"] == "working" {
		if frame := readWS(t, conn); frame["type"] != "feed" || frame["event"].(map[string]any)["source"] != "herdr-agent-status" {
			t.Fatal(frame)
		}
	}

}

func TestWSInitialFramesAndSelectedCapture(t *testing.T) {
	f := newWSFixture(t, &fakeBackend{content: "visible terminal"}, time.Hour)
	conn := f.connect(t)
	initialWS(t, conn)
	sendWS(t, conn, map[string]any{"type": "select", "target": "default/w1:1"})
	frame := readWS(t, conn)
	if frame["type"] != "capture" || frame["target"] != "default/w1:1" || frame["content"] != "visible terminal" {
		t.Fatalf("capture: %v", frame)
	}
}

func TestWSTicketUpgradeGuards(t *testing.T) {
	cases := []struct {
		name, path, origin string
		offers             func(string) []string
		status             int
		expire             bool
	}{
		{"missing ticket", "/ws", dashboardOrigin, func(string) []string { return []string{protocol} }, 401, false},
		{"invalid ticket", "/ws", dashboardOrigin, func(string) []string { return []string{protocol, "mwt1_" + strings.Repeat("0", 64)} }, 401, false},
		{"wrong allowed origin", "/ws", "http://localhost", func(v string) []string { return []string{protocol, v} }, 401, false},
		{"untrusted origin", "/ws", "https://evil.example", func(v string) []string { return []string{protocol, v} }, 403, false},
		{"missing origin", "/ws", "", func(v string) []string { return []string{protocol, v} }, 403, false},
		{"query credential", "/ws?token=secret", dashboardOrigin, func(v string) []string { return []string{protocol, v} }, 400, false},
		{"empty query", "/ws?", dashboardOrigin, func(v string) []string { return []string{protocol, v} }, 400, false},
		{"wrong protocol", "/ws", dashboardOrigin, func(v string) []string { return []string{"other", v} }, 401, false},
		{"expired ticket", "/ws", dashboardOrigin, func(v string) []string { return []string{protocol, v} }, 401, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b := &fakeBackend{}
			f := newWSFixture(t, b, time.Hour)
			value := f.ticket(t)
			if tc.expire {
				f.server.mu.Lock()
				ticket := f.server.tickets[value]
				ticket.expires = time.Now().Add(-time.Second)
				f.server.tickets[value] = ticket
				f.server.mu.Unlock()
			}
			conn, res, err := f.dial(t, tc.path, tc.origin, tc.offers(value))
			if conn != nil {
				conn.CloseNow()
			}
			if err == nil || res == nil || res.StatusCode != tc.status {
				t.Fatalf("upgrade: response=%v error=%v", res, err)
			}
			b.mu.Lock()
			defer b.mu.Unlock()
			if b.sends != 0 {
				t.Fatal("unauthorized connection mutated backend")
			}
		})
	}
}

func TestWSTicketCannotBeReplayed(t *testing.T) {
	f := newWSFixture(t, &fakeBackend{}, time.Hour)
	ticket := f.ticket(t)
	conn, _, err := f.dial(t, "/ws", dashboardOrigin, []string{protocol, ticket})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	initialWS(t, conn)
	replay, res, err := f.dial(t, "/ws", dashboardOrigin, []string{protocol, ticket})
	if replay != nil {
		replay.CloseNow()
	}
	if err == nil || res == nil || res.StatusCode != 401 {
		t.Fatalf("replay accepted: %v %v", res, err)
	}
}

func TestWSSendAcknowledgesAcceptanceAndRejectsUnsupportedOptions(t *testing.T) {
	b := &fakeBackend{}
	f := newWSFixture(t, b, time.Hour)
	conn := f.connect(t)
	initialWS(t, conn)
	for _, option := range []string{"inbox", "attachments"} {
		command := map[string]any{"type": "send", "target": "default/w1:1", "text": "hello", option: true}
		if option == "attachments" {
			command[option] = []string{"file"}
		}
		sendWS(t, conn, command)
		if frame := readWS(t, conn); frame["type"] != "error" || frame["error"] != "send_options_not_supported" {
			t.Fatalf("unsupported option: %v", frame)
		}
	}
	b.mu.Lock()
	count := b.sends
	b.mu.Unlock()
	if count != 0 {
		t.Fatal("unsupported send mutated backend")
	}
	sendWS(t, conn, map[string]any{"type": "send", "target": "default/w1:1", "text": "literal; $(no-shell)"})
	frame := readWS(t, conn)
	if frame["type"] != "sent" || frame["ok"] != true || frame["state"] != "accepted" || frame["text"] != "literal; $(no-shell)" {
		t.Fatalf("ack: %v", frame)
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.sends != 1 {
		t.Fatalf("send count: %d", b.sends)
	}
}

type previewBackend struct {
	fakeBackend
	captureMu  sync.Mutex
	captures   []string
	removed    bool
	generation string
}

func (b *previewBackend) Sessions(context.Context) ([]Session, error) {
	b.captureMu.Lock()
	defer b.captureMu.Unlock()
	windows := []Window{{Index: 1, Name: "agent", Active: true, Agent: "codex"}}
	for i := 2; i <= 4; i++ {
		if i != 2 || !b.removed {
			windows = append(windows, Window{Index: i, Name: "preview"})
		}
	}
	return []Session{{Name: "default/w1", Source: "local", Windows: windows}}, nil
}

func (b *previewBackend) Capture(_ context.Context, target string, lines int) (string, error) {
	b.captureMu.Lock()
	defer b.captureMu.Unlock()
	b.captures = append(b.captures, target)
	if b.removed && target == "default/w1:2" {
		return "", ErrTargetNotFound
	}
	return target + b.generation, nil
}

func (b *previewBackend) CaptureBatch(ctx context.Context, targets map[string]int) (map[string]string, error) {
	result := make(map[string]string, len(targets))
	for target, lines := range targets {
		content, err := b.Capture(ctx, target, lines)
		if err != nil {
			return nil, err
		}
		result[target] = content
	}
	return result, nil
}

func TestWSPreviewSubscriptionsReplaceAndDeduplicate(t *testing.T) {
	b := &previewBackend{}
	f := newWSFixture(t, b, time.Hour)
	conn := f.connect(t)
	initialWS(t, conn)
	sendWS(t, conn, map[string]any{"type": "subscribe-previews", "targets": []string{"default/w1:2", "default/w1:2", "default/w1:3"}})
	frame := readWS(t, conn)
	if frame["type"] != "previews" || len(frame["data"].(map[string]any)) != 2 {
		t.Fatalf("preview: %v", frame)
	}
	b.captureMu.Lock()
	count := len(b.captures)
	b.captures = nil
	b.captureMu.Unlock()
	if count != 2 {
		t.Fatalf("duplicate target captured %d times", count)
	}
	sendWS(t, conn, map[string]any{"type": "subscribe-previews", "targets": []string{"default/w1:4"}})
	frame = readWS(t, conn)
	if data := frame["data"].(map[string]any); len(data) != 1 || data["default/w1:4"] != "default/w1:4" {
		t.Fatalf("replacement: %v", frame)
	}
	b.captureMu.Lock()
	defer b.captureMu.Unlock()
	if len(b.captures) != 1 || b.captures[0] != "default/w1:4" {
		t.Fatalf("stale subscription retained: %v", b.captures)
	}
}

func TestWSUnchangedPreviewsAreNotResentAndUnsubscribeClearsThem(t *testing.T) {
	b := &previewBackend{}
	f := newWSFixture(t, b, time.Hour)
	conn := f.connect(t)
	initialWS(t, conn)
	sendWS(t, conn, map[string]any{"type": "subscribe-previews", "targets": []string{"default/w1:2"}})
	if frame := readWS(t, conn); frame["type"] != "previews" {
		t.Fatal(frame)
	}
	// Selecting a main pane triggers a new capture batch with unchanged previews.
	sendWS(t, conn, map[string]any{"type": "select", "target": "default/w1:1"})
	if frame := readWS(t, conn); frame["type"] != "capture" {
		t.Fatal(frame)
	}
	sendWS(t, conn, map[string]any{"type": "send", "target": "default/w1:1", "text": "barrier"})
	if frame := readWS(t, conn); frame["type"] != "sent" {
		t.Fatalf("unchanged preview was resent: %v", frame)
	}
	b.captureMu.Lock()
	b.captures = nil
	b.captureMu.Unlock()
	sendWS(t, conn, map[string]any{"type": "subscribe-previews", "targets": []string{}})
	sendWS(t, conn, map[string]any{"type": "send", "target": "default/w1:1", "text": "barrier"})
	if frame := readWS(t, conn); frame["type"] != "sent" {
		t.Fatal(frame)
	}
	b.captureMu.Lock()
	defer b.captureMu.Unlock()
	for _, target := range b.captures {
		if target == "default/w1:2" {
			t.Fatal("unsubscribed preview still captured")
		}
	}
}

func TestWSInitialBackendFailureReportsErrorThenCloses(t *testing.T) {
	f := newWSFixture(t, &fakeBackend{failure: true}, time.Hour)
	conn := f.connect(t)
	if frame := readWS(t, conn); frame["type"] != "error" || frame["error"] != "herdr_unavailable" {
		t.Fatalf("failure must not look like empty sessions: %v", frame)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, _, err := conn.Read(ctx); err == nil || ctx.Err() != nil {
		t.Fatalf("expected immediate connection close: %v", err)
	}
}

func TestWSMidstreamBackendFailurePreservesRosterAndRecovers(t *testing.T) {
	b := &fakeBackend{content: "before"}
	f := newWSFixture(t, b, 10*time.Millisecond)
	conn := f.connect(t)
	initialWS(t, conn)
	sendWS(t, conn, map[string]any{"type": "select", "target": "default/w1:1"})
	if frame := readWS(t, conn); frame["content"] != "before" {
		t.Fatal(frame)
	}
	b.mu.Lock()
	b.failure = true
	b.mu.Unlock()
	frame := readWS(t, conn)
	if frame["type"] != "error" || frame["error"] != "herdr_unavailable" {
		t.Fatalf("failure replaced roster: %v", frame)
	}
	b.mu.Lock()
	b.failure = false
	b.content = "after"
	b.mu.Unlock()
	for attempt := 0; attempt < 10; attempt++ {
		frame = readWS(t, conn)
		if frame["type"] == "error" {
			continue
		} // A poll already in flight may report the prior failure.
		if frame["type"] != "capture" || frame["content"] != "after" {
			t.Fatalf("recovery: %v", frame)
		}
		return
	}
	t.Fatal("backend did not recover within 10 frames")
}

func TestWSCloseStopsActiveHandler(t *testing.T) {
	f := newWSFixture(t, &fakeBackend{}, time.Hour)
	conn := f.connect(t)
	initialWS(t, conn)
	f.server.Close()
	select {
	case <-f.done:
	case <-time.After(2 * time.Second):
		t.Fatal("server cancellation left websocket handler running")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, _, err := conn.Read(ctx); err == nil || ctx.Err() != nil {
		t.Fatalf("socket remained open after Close: %v", err)
	}
}

func TestWSRejectsMalformedAndOversizedMessages(t *testing.T) {
	cases := []struct {
		name   string
		kind   websocket.MessageType
		data   string
		status websocket.StatusCode
	}{
		{"binary", websocket.MessageBinary, `{}`, websocket.StatusUnsupportedData},
		{"malformed JSON", websocket.MessageText, `{`, websocket.StatusPolicyViolation},
		{"unknown field", websocket.MessageText, `{"type":"send","unexpected":true}`, websocket.StatusPolicyViolation},
		{"trailing JSON", websocket.MessageText, `{} {}`, websocket.StatusPolicyViolation},
		{"oversized", websocket.MessageText, strings.Repeat("x", 65<<10), websocket.StatusMessageTooBig},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b := &fakeBackend{}
			f := newWSFixture(t, b, time.Hour)
			conn := f.connect(t)
			initialWS(t, conn)
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			// An oversized write can race the peer's immediate close; the read proves the close reason.
			_ = conn.Write(ctx, tc.kind, []byte(tc.data))
			_, _, err := conn.Read(ctx)
			if websocket.CloseStatus(err) != tc.status {
				t.Fatalf("close status = %v (%v), want %v", websocket.CloseStatus(err), err, tc.status)
			}
			b.mu.Lock()
			defer b.mu.Unlock()
			if b.sends != 0 {
				t.Fatal("invalid frame caused backend mutation")
			}
		})
	}
}

func TestWSDepartedPreviewDoesNotStarveSurvivingPane(t *testing.T) {
	b := &previewBackend{}
	f := newWSFixture(t, b, 10*time.Millisecond)
	conn := f.connect(t)
	initialWS(t, conn)
	sendWS(t, conn, map[string]any{"type": "subscribe-previews", "targets": []string{"default/w1:1", "default/w1:2"}})
	if frame := readWS(t, conn); frame["type"] != "previews" {
		t.Fatal(frame)
	}
	sendWS(t, conn, map[string]any{"type": "select", "target": "default/w1:1"})
	if frame := readWS(t, conn); frame["type"] != "capture" {
		t.Fatal(frame)
	}
	b.captureMu.Lock()
	b.removed = true
	b.generation = " updated"
	b.captureMu.Unlock()
	errorsSeen := 0
	sawCapture, sawPreview := false, false
	for i := 0; i < 10 && !(sawCapture && sawPreview); i++ {
		frame := readWS(t, conn)
		switch frame["type"] {
		case "sessions", "recent":
		case "error":
			if frame["error"] != "subscription_target_gone" {
				t.Fatalf("unexpected failure: %v", frame)
			}
			errorsSeen++
		case "capture":
			if frame["target"] != "default/w1:1" || frame["content"] != "default/w1:1 updated" {
				t.Fatal(frame)
			}
			sawCapture = true
		case "previews":
			data := frame["data"].(map[string]any)
			if len(data) != 1 || data["default/w1:1"] != "default/w1:1 updated" {
				t.Fatalf("departed preview retained: %v", frame)
			}
			sawPreview = true
		default:
			t.Fatalf("unexpected frame: %v", frame)
		}
	}
	if errorsSeen != 1 || !sawCapture || !sawPreview {
		t.Fatalf("errors=%d capture=%v preview=%v", errorsSeen, sawCapture, sawPreview)
	}
	// Another capture cycle must not report the departed target again.
	sendWS(t, conn, map[string]any{"type": "select", "target": "default/w1:1"})
	if frame := readWS(t, conn); frame["type"] != "capture" {
		t.Fatalf("departure error repeated: %v", frame)
	}
	sendWS(t, conn, map[string]any{"type": "send", "target": "default/w1:1", "text": "barrier"})
	if frame := readWS(t, conn); frame["type"] != "sent" {
		t.Fatal(frame)
	}
}

func TestWSRecentKeepsOnlyDetectedAgentsWithoutDroppingShellWindows(t *testing.T) {
	backend, _, _ := testBackend(t)
	f := newWSFixture(t, backend, time.Hour)
	conn := f.connect(t)
	frame := readWS(t, conn)
	sessions := frame["sessions"].([]any)
	windows := sessions[0].(map[string]any)["windows"].([]any)
	if len(windows) != 2 {
		t.Fatal("shell window disappeared", frame)
	}
	recent := readWS(t, conn)
	agents := recent["agents"].([]any)
	if len(agents) != 1 || agents[0].(map[string]any)["target"] != "bWFpbg/d0Q:4" {
		t.Fatal("shell advertised as agent", recent)
	}
	if windows[0].(map[string]any)["agent"] != "codex" {
		t.Fatal("detected identity missing", frame)
	}
	if value, ok := windows[1].(map[string]any)["agent"]; ok && value != "" {
		t.Fatal("shell has agent", value)
	}
}
