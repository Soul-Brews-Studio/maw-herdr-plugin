package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

const testToken = "0123456789abcdef-test-token"

type fakeBackend struct {
	mu       sync.Mutex
	failure  bool
	sends    int
	content  string
	lastSend string
}

func (b *fakeBackend) Sessions(context.Context) ([]Session, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.failure {
		return nil, errors.New("private backend failure")
	}
	return []Session{{Name: "default/w1", Source: "local", Windows: []Window{{Index: 1, Name: "agent", Active: true, Status: "working", Agent: "codex"}}}}, nil
}
func (b *fakeBackend) Capture(_ context.Context, target string, _ int) (string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.failure {
		return "", errors.New("private capture failure")
	}
	if target != "default/w1:1" {
		return "", ErrTargetNotFound
	}
	return b.content, nil
}
func (b *fakeBackend) CaptureBatch(ctx context.Context, targets map[string]int) (map[string]string, error) {
	result := map[string]string{}
	for target, lines := range targets {
		content, err := b.Capture(ctx, target, lines)
		if err != nil {
			return nil, err
		}
		result[target] = content
	}
	return result, nil
}
func (b *fakeBackend) Send(_ context.Context, target, text string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.failure {
		return errors.New("private send failure")
	}
	if target != "default/w1:1" {
		return ErrTargetNotFound
	}
	b.sends++
	b.lastSend = text
	return nil
}

func testServer(t *testing.T) (*Server, *fakeBackend) {
	t.Helper()
	t.Setenv("PEERS_FILE", federationTempDir(t)+"/peers.json")
	b := &fakeBackend{content: "visible terminal"}
	s, err := NewServer(Config{Token: testToken, DataDir: t.TempDir()}, b)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s, b
}

func request(s *Server, method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://127.0.0.1:3457"+path, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+testToken)
	r.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		if v == "" {
			r.Header.Del(k)
		} else {
			r.Header.Set(k, v)
		}
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

func TestAPICoreContracts(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	s, b := testServer(t)
	for _, path := range []string{"/api/sessions", "/api/agents", "/api/agent", "/api/identity", "/api/config", "/api/teams", "/api/costs", "/api/feed", "/api/captures", "/api/health"} {
		w := request(s, "GET", path, "", nil)
		if w.Code != 200 || !json.Valid(w.Body.Bytes()) {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body)
		}
		if strings.Contains(w.Body.String(), testToken) {
			t.Fatal("token leaked")
		}
	}
	w := request(s, "GET", "/api/sessions", "", nil)
	var sessions []Session
	if err := json.Unmarshal(w.Body.Bytes(), &sessions); err != nil || len(sessions) != 1 || sessions[0].Windows[0].Index != 1 {
		t.Fatalf("session shape: %s", w.Body)
	}
	w = request(s, "GET", "/api/capture?target=default/w1:1", "", nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "visible terminal") {
		t.Fatal(w.Body)
	}
	if w := request(s, "GET", "/api/capture", "", nil); w.Code != 400 {
		t.Fatal(w.Code)
	}
	if w := request(s, "GET", "/api/capture?target=gone", "", nil); w.Code != 400 || !strings.Contains(w.Body.String(), `"error"`) {
		t.Fatal(w.Body)
	}
	w = request(s, "POST", "/api/send", `{"target":"default/w1:1","text":"hello; $(touch nope)"}`, nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"state":"accepted"`) || b.sends != 1 {
		t.Fatalf("send: %d %s", w.Code, w.Body)
	}
	for _, body := range []string{`{"target":"default/w1:1","text":"x","force":true}`, `{"target":"default/w1:1","text":"x","inbox":true}`} {
		if w := request(s, "POST", "/api/send", body, nil); w.Code != 501 {
			t.Fatal(w.Code, w.Body)
		}
	}
	if b.sends != 1 {
		t.Fatal("unsupported options caused write")
	}
	if w := request(s, "POST", "/api/send", `{"target":"gone","text":"x"}`, nil); w.Code != 404 {
		t.Fatal(w.Code, w.Body)
	}
	if w := request(s, "POST", "/api/wake", `{}`, nil); w.Code < 400 {
		t.Fatal("unsupported action succeeded")
	}
	if w := request(s, "GET", "/api/config?raw=1", "", nil); w.Code != 400 {
		t.Fatal(w.Code)
	}
}

func TestBackendFailureHonesty(t *testing.T) {
	s, b := testServer(t)
	b.failure = true
	for _, path := range []string{"/api/sessions", "/api/agents", "/api/captures", "/health"} {
		w := request(s, "GET", path, "", nil)
		if w.Code != 503 || strings.Contains(w.Body.String(), "private") {
			t.Fatal(path, w.Code, w.Body)
		}
	}
	if w := request(s, "POST", "/api/send", `{"target":"default/w1:1","text":"x"}`, nil); w.Code != 503 {
		t.Fatal(w.Code)
	}
	if b.sends != 0 {
		t.Fatal("failed backend write counted")
	}
}

func TestJSONValidation(t *testing.T) {
	s, b := testServer(t)
	for _, body := range []string{`null`, `{}`, `[]`, `{"target":"default/w1:1","text":"x","unknown":true}`, `{"target":"default/w1:1","text":"x"} {}`, strings.Repeat("x", 65<<10)} {
		if w := request(s, "POST", "/api/send", body, nil); w.Code != 400 {
			t.Fatalf("status %d", w.Code)
		}
	}
	if w := request(s, "POST", "/api/send", `{}`, map[string]string{"Content-Type": "text/plain"}); w.Code != 415 {
		t.Fatal(w.Code)
	}
	if b.sends != 0 {
		t.Fatal("invalid input caused mutation")
	}
}

func TestStatePersistence(t *testing.T) {
	s, _ := testServer(t)
	for path, body := range map[string]string{"/api/ui-state": `{"selected":"agent"}`, "/api/asks": `[{"text":"hello"}]`} {
		if w := request(s, "GET", path, "", nil); w.Code != 200 {
			t.Fatal(w.Body)
		}
		if w := request(s, "POST", path, body, nil); w.Code != 200 {
			t.Fatal(w.Body)
		}
		if w := request(s, "GET", path, "", nil); strings.TrimSpace(w.Body.String()) != body {
			t.Fatal(w.Body)
		}
		if w := request(s, "POST", path, `null`, nil); w.Code != 400 {
			t.Fatal(w.Code)
		}
	}
}

func TestSecurityBeforeSideEffects(t *testing.T) {
	s, b := testServer(t)
	body := `{"target":"default/w1:1","text":"do not send"}`
	for _, origin := range []string{"null", "https://evil.example", "https://god.buildwithoracle.com.evil.example", "https://god.buildwithoracle.com/", "https://god.buildwithoracle.com#", "https://god.buildwithoracle.com?", "http://localhost.evil", "http://127.0.0.1@evil.example", "file://localhost"} {
		w := request(s, "POST", "/api/send", body, map[string]string{"Origin": origin})
		if w.Code != 403 || w.Header().Get("Access-Control-Allow-Origin") != "" {
			t.Fatalf("%q: %d", origin, w.Code)
		}
	}
	for _, token := range []string{"", "Bearer bad", "Basic " + testToken} {
		w := request(s, "POST", "/api/send", body, map[string]string{"Origin": "https://god.buildwithoracle.com", "Authorization": token})
		if w.Code != 401 || w.Header().Get("Access-Control-Allow-Origin") != "https://god.buildwithoracle.com" {
			t.Fatal(w.Code, w.Header())
		}
	}
	r := httptest.NewRequest("POST", "http://evil.example/api/send", strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+testToken)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
	r = httptest.NewRequest("POST", "http://localhost/api/send", strings.NewReader(body))
	r.Header.Add("Origin", "http://localhost")
	r.Header.Add("Origin", "http://localhost")
	w = httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
	if b.sends != 0 {
		t.Fatal("security failure reached backend")
	}
}

func TestPreflight(t *testing.T) {
	s, _ := testServer(t)
	headers := map[string]string{"Origin": "https://god.buildwithoracle.com", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization, content-type", "Access-Control-Request-Private-Network": "true", "Authorization": ""}
	w := request(s, "OPTIONS", "/api/send", "", headers)
	if w.Code != 204 || w.Header().Get("Access-Control-Allow-Private-Network") != "true" {
		t.Fatal(w.Code, w.Header())
	}
	for key, value := range map[string]string{"Access-Control-Request-Method": "DELETE", "Access-Control-Request-Headers": "authorization, authorization", "Access-Control-Request-Private-Network": "false"} {
		old := headers[key]
		headers[key] = value
		if w := request(s, "OPTIONS", "/api/send", "", headers); w.Code != 403 {
			t.Fatal(key, w.Code)
		}
		headers[key] = old
	}
}

func TestTicketShapeAndValidation(t *testing.T) {
	s, _ := testServer(t)
	h := map[string]string{"Origin": "https://god.buildwithoracle.com"}
	w := request(s, "POST", "/api/auth/ws-ticket", `{"path":"/ws"}`, h)
	var value map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &value); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || len(value) != 2 || value["protocol"] != protocol || len(value["ticket"]) != 69 || !strings.HasPrefix(value["ticket"], "mwt1_") {
		t.Fatal(w.Code, w.Body)
	}
	if s.consumeTicket(value["ticket"], "http://localhost", "/ws") {
		t.Fatal("wrong origin accepted")
	}
	if !s.consumeTicket(value["ticket"], h["Origin"], "/ws") || s.consumeTicket(value["ticket"], h["Origin"], "/ws") {
		t.Fatal("not one-use")
	}
	for _, body := range []string{`{"path":"/ws/tmux"}`, `{"path":"/ws","extra":1}`, `{}`, `null`, strings.Repeat(" ", 128) + `{"path":"/ws"}`} {
		if w := request(s, "POST", "/api/auth/ws-ticket", body, h); w.Code != 400 {
			t.Fatal(w.Code, w.Body)
		}
	}
	if w := request(s, "POST", "/api/auth/ws-ticket", `{"path":"/ws"}`, nil); w.Code != 400 {
		t.Fatal(w.Code)
	}
	if w := request(s, "POST", "/api/auth/ws-ticket?x=1", `{"path":"/ws"}`, h); w.Code != 400 {
		t.Fatal(w.Code)
	}
	if w := request(s, "GET", "/api/auth/ws-ticket", "", h); w.Code != 405 {
		t.Fatal(w.Code)
	}
	if _, err := NewServer(Config{Token: "short"}, &fakeBackend{}); err == nil {
		t.Fatal("short token accepted")
	}
}

var _ http.Handler = (*Server)(nil)

func TestCaptureContract(t *testing.T) {
	s, b := testServer(t)
	w := request(s, "GET", "/api/capture?target=default/w1:1", "", nil)
	var result map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || len(result) != 3 || result["content"] != "visible terminal" || result["target"] != "default/w1:1" || result["resolvedTarget"] != "default/w1:1" {
		t.Fatal(w.Code, result)
	}
	for _, target := range []string{"gone", "default/w1:1"} {
		b.failure = target != "gone"
		w = request(s, "GET", "/api/capture?target="+target, "", nil)
		result = nil
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if w.Code != 400 || result["error"] != "capture_unavailable" || strings.Contains(w.Body.String(), "private") {
			t.Fatal(w.Code, result)
		}
	}
}

func (b *fakeBackend) Input(ctx context.Context, target, text string, _ bool) error {
	return b.Send(ctx, target, text)
}

func TestSendAttachmentStrings(t *testing.T) {
	for _, tc := range []struct{ body, want string }{
		{`{"target":"default/w1:1","text":"review","attachments":["/not/a/file","https://example.invalid/a"]}`, "/not/a/file\nhttps://example.invalid/a\nreview"},
		{`{"target":"default/w1:1","attachments":["/not/a/file"]}`, "/not/a/file\n"},
	} {
		s, b := testServer(t)
		w := request(s, "POST", "/api/send", tc.body, nil)
		if w.Code != 200 || b.lastSend != tc.want {
			t.Fatalf("send: %d %s text=%q", w.Code, w.Body, b.lastSend)
		}
		var result map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || result["text"] != tc.want {
			t.Fatalf("response: %s", w.Body)
		}
	}
}

func TestSendRejectsMalformedAttachments(t *testing.T) {
	for _, attachments := range []string{`[null]`, `[1]`, `[{}]`, `"path"`} {
		s, b := testServer(t)
		w := request(s, "POST", "/api/send", `{"target":"default/w1:1","text":"valid","attachments":`+attachments+`}`, nil)
		if w.Code != 400 || b.sends != 0 {
			t.Fatalf("%s: %d %s sends=%d", attachments, w.Code, w.Body, b.sends)
		}
	}
}
