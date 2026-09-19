package main

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestEngineConfig(t *testing.T) {
	valid := map[string]string{"MAW_SERVE_TOKEN": testToken, "MAW_ENGINE_SERVE_PORT": "4567", "MAW_ENGINE_SERVE_PREFIX": enginePrefix}
	configure := func(overrides map[string]string, flags map[string]bool) (Config, string, error) {
		return engineConfig(func(key string) string {
			if value, ok := overrides[key]; ok {
				return value
			}
			return valid[key]
		}, flags)
	}
	config, listen, err := configure(nil, nil)
	if err != nil || !config.Engine || config.Prefix != enginePrefix || listen != "127.0.0.1:4567" {
		t.Fatalf("%+v %s %v", config, listen, err)
	}
	for _, override := range []map[string]string{
		{"MAW_SERVE_TOKEN": ""}, {"MAW_SERVE_TOKEN": " short "},
		{"MAW_ENGINE_SERVE_PORT": ""}, {"MAW_ENGINE_SERVE_PORT": "0"}, {"MAW_ENGINE_SERVE_PORT": "65536"},
		{"MAW_ENGINE_SERVE_PORT": "-1"}, {"MAW_ENGINE_SERVE_PORT": " 4567"}, {"MAW_ENGINE_SERVE_PORT": "+4567"},
		{"PORT": "4568"}, {"MAW_ENGINE_SERVE_PREFIX": ""}, {"MAW_ENGINE_SERVE_PREFIX": "/api/herdr/"},
	} {
		if _, _, err := configure(override, nil); err == nil {
			t.Fatalf("accepted invalid environment: %v", override)
		}
	}
	for _, flag := range []string{"listen", "token-file"} {
		if _, _, err := configure(nil, map[string]bool{flag: true}); err == nil {
			t.Fatalf("accepted --%s", flag)
		}
	}
	if _, _, err := configure(map[string]string{"PORT": "4567", "MAW_SERVE_TOKEN": " " + testToken + " "}, nil); err != nil {
		t.Fatal(err)
	}
}

func newEngineServer(t *testing.T) (*Server, *fakeBackend) {
	t.Helper()
	b := &fakeBackend{content: "engine pane"}
	s, err := NewServer(Config{Engine: true, Prefix: enginePrefix, Token: testToken, DataDir: t.TempDir()}, b)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s, b
}

func TestEngineBoundaryAndRouting(t *testing.T) {
	s, b := newEngineServer(t)
	for _, tc := range []struct {
		name, path, peer, host string
		origin                 *string
		status                 int
	}{
		{"sessions", "/api/herdr/sessions", "127.0.0.1:1234", "localhost:4567", nil, 200},
		{"identity", "/api/herdr", "[::1]:1234", "[::1]:4567", nil, 200},
		{"health", "/api/herdr/health", "127.0.0.1:1234", "127.0.0.1:4567", nil, 200},
		{"outside", "/api/sessions", "127.0.0.1:1234", "localhost", nil, 404},
		{"prefix boundary", "/api/herdrish/sessions", "127.0.0.1:1234", "localhost", nil, 404},
		{"ticket", "/api/herdr/auth/ws-ticket", "127.0.0.1:1234", "localhost", nil, 501},
		{"remote", "/api/herdr/send", "192.0.2.1:1234", "localhost", nil, 403},
		{"peer hostname", "/api/herdr/send", "localhost:1234", "localhost", nil, 403},
		{"bad host", "/api/herdr/send", "127.0.0.1:1234", "evil.example", nil, 403},
		{"browser", "/api/herdr/send", "127.0.0.1:1234", "localhost", ptr(dashboardOrigin), 403},
		{"empty origin", "/api/herdr/send", "127.0.0.1:1234", "localhost", ptr(""), 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			method := "GET"
			if strings.HasSuffix(tc.path, "/send") {
				method = "POST"
			}
			r := httptest.NewRequest(method, "http://localhost"+tc.path, strings.NewReader(`{"target":"default/w1:1","text":"hello"}`))
			r.RemoteAddr, r.Host = tc.peer, tc.host
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("X-Forwarded-For", "127.0.0.1")
			r.Header.Set("Forwarded", "for=127.0.0.1;host=localhost")
			if tc.origin != nil {
				r.Header["Origin"] = []string{*tc.origin}
			}
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("%d %s", w.Code, w.Body)
			}
		})
	}
	if b.sends != 0 {
		t.Fatal("rejected requests caused a backend send")
	}
	r := httptest.NewRequest("POST", "http://localhost/api/herdr/send", strings.NewReader(`{"target":"default/w1:1","text":"hello"}`))
	r.RemoteAddr = "127.0.0.1:1234"
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 200 || b.sends != 1 {
		t.Fatalf("trusted local send: %d %s %d", w.Code, w.Body, b.sends)
	}
}

func ptr(s string) *string { return &s }

func TestEngineWebSocket(t *testing.T) {
	s, _ := newEngineServer(t)
	h := httptest.NewServer(s)
	defer h.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(h.URL, "http")+"/api/herdr/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if conn.Subprotocol() != "" {
		t.Fatal("unexpected negotiated protocol")
	}
	for _, want := range []string{"feed-history", "sessions", "recent"} {
		if frame := readWS(t, conn); frame["type"] != want {
			t.Fatalf("%v", frame)
		}
	}
	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"type":"select","target":"default/w1:1"}`)); err != nil {
		t.Fatal(err)
	}
	if frame := readWS(t, conn); frame["type"] != "capture" || frame["content"] != "engine pane" {
		t.Fatalf("%v", frame)
	}
}

func TestEngineConfigRejectsInvalidServerPrefix(t *testing.T) {
	if _, err := NewServer(Config{Engine: true, Prefix: "/api/other", Token: testToken}, &fakeBackend{}); err == nil {
		t.Fatal("engine server accepted a different prefix")
	}
}

func TestEngineEnvironmentDoesNotEnableStandalone(t *testing.T) {
	t.Setenv("MAW_SERVE_TOKEN", testToken)
	t.Setenv("MAW_ENGINE_SERVE_PORT", "4567")
	t.Setenv("MAW_ENGINE_SERVE_PREFIX", enginePrefix)
	s, _ := testServer(t)
	if w := request(s, "GET", "/api/sessions", "", map[string]string{"Authorization": ""}); w.Code != 401 {
		t.Fatalf("standalone bypassed: %d", w.Code)
	}
	previous := os.Args
	os.Args = []string{"maw-herdr-serve"}
	defer func() { os.Args = previous }()
	if err := run(); err == nil || !strings.Contains(err.Error(), "--token-file is required") {
		t.Fatalf("standalone env bypass: %v", err)
	}
}

func TestIdentityEndpointsMatchServingMode(t *testing.T) {
	for _, engine := range []bool{false, true} {
		name, path := "standalone", "/api/identity"
		s, _ := testServer(t)
		want := []string{"/api/sessions", "/api/capture", "/api/send", "/ws"}
		if engine {
			name, path = "engine", "/api/herdr"
			s, _ = newEngineServer(t)
			want = []string{"/api/herdr/sessions", "/api/herdr/capture", "/api/herdr/send", "/api/herdr/ws"}
		}
		t.Run(name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "http://localhost"+path, nil)
			r.RemoteAddr = "127.0.0.1:1234"
			if !engine {
				r.Header.Set("Authorization", "Bearer "+testToken)
			}
			w := httptest.NewRecorder()
			s.ServeHTTP(w, r)
			var identity struct {
				Endpoints []string `json:"endpoints"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &identity); err != nil {
				t.Fatal(err)
			}
			if w.Code != 200 || !reflect.DeepEqual(identity.Endpoints, want) {
				t.Fatalf("identity endpoints: status=%d got=%v want=%v", w.Code, identity.Endpoints, want)
			}
		})
	}
}
