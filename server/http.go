package main

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func fail(w http.ResponseWriter, status int, reason string) {
	writeJSON(w, status, map[string]string{"error": reason})
}

func methodNotAllowed(w http.ResponseWriter, methods string) {
	w.Header().Set("Allow", methods)
	fail(w, 405, "method_not_allowed")
}

func decodeJSON(w http.ResponseWriter, r *http.Request, value any, limit int64) bool {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		fail(w, 415, "application_json_required")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		fail(w, 400, "invalid_json")
		return false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		fail(w, 400, "invalid_json")
		return false
	}
	return true
}

func backendFailure(w http.ResponseWriter, err error) {
	if errors.Is(err, ErrTargetNotFound) {
		fail(w, 404, "target_not_found")
	} else if errors.Is(err, ErrNotAgent) {
		fail(w, 409, "target_not_agent")
	} else {
		fail(w, 503, "herdr_unavailable")
	}
}

func (s *Server) serveAPI(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/api/worktrees" || r.URL.Path == "/api/worktrees/cleanup" {
		s.serveWorktrees(w, r)
		return
	}
	if r.URL.Path == "/api/ui-state" || r.URL.Path == "/api/asks" {
		s.serveState(w, r)
		return
	}
	if r.URL.Path == "/api/wake" {
		if r.Method != "POST" {
			methodNotAllowed(w, "POST")
			return
		}
		s.serveWake(w, r)
		return
	}
	if r.URL.Path == "/api/send" {
		if r.Method != "POST" {
			methodNotAllowed(w, "POST")
			return
		}
		s.serveSend(w, r)
		return
	}
	if r.URL.Path == "/api/feed" && r.Method == "POST" {
		s.serveFeedActivity(w, r)
		return
	}
	if r.Method != "GET" {
		if r.URL.Path == "/api/feed" {
			methodNotAllowed(w, "GET, POST")
			return
		}
		methodNotAllowed(w, "GET")
		return
	}
	switch r.URL.Path {
	case "/api/federation/status", "/fed.json":
		c, err := readFederationConfigAt(true, s.configRoot)
		if err != nil {
			if errors.Is(err, errConfig) {
				fail(w, 503, "config_unavailable")
				return
			}
			fail(w, 503, "federation_unavailable")
			return
		}
		payload, err := s.federationStatus(r.Context(), c)
		if err != nil {
			fail(w, 503, "federation_unavailable")
			return
		}
		writeJSON(w, 200, payload)
	case "/api/sessions":
		sessions, err := s.backend.Sessions(r.Context())
		if err != nil {
			backendFailure(w, err)
			return
		}
		writeJSON(w, 200, sessions)
	case "/api/capture":
		target := r.URL.Query().Get("target")
		if target == "" {
			fail(w, 400, "target_required")
			return
		}
		content, err := s.backend.Capture(r.Context(), target, 200)
		if err != nil {
			fail(w, 400, "capture_unavailable")
			return
		}
		writeJSON(w, 200, map[string]string{"content": content, "target": target, "resolvedTarget": target})
	case "/api/captures":
		sessions, err := s.backend.Sessions(r.Context())
		if err != nil {
			backendFailure(w, err)
			return
		}
		targets := map[string]int{}
		for _, session := range sessions {
			for _, window := range session.Windows {
				targets[session.Name+":"+strconv.Itoa(window.Index)] = 200
			}
		}
		if len(targets) > 64 {
			fail(w, 400, "too_many_captures")
			return
		}
		captures, err := s.backend.CaptureBatch(r.Context(), targets)
		if err != nil {
			backendFailure(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"captures": captures})
	case "/api/agents", "/api/agent":
		sessions, err := s.backend.Sessions(r.Context())
		if err != nil {
			backendFailure(w, err)
			return
		}
		agents := []map[string]any{}
		for _, session := range sessions {
			for _, window := range session.Windows {
				state := "idle"
				if window.Status == "working" {
					state = "active"
				}
				agents = append(agents, map[string]any{"node": s.config.Node, "session": session.Name, "window": strconv.Itoa(window.Index), "oracle": window.Name, "state": state, "pid": nil})
			}
		}
		writeJSON(w, 200, map[string]any{"agents": agents, "count": len(agents), "node": s.config.Node})
	case "/api/identity":
		endpoints := []string{"/api/sessions", "/api/capture", "/api/send", "/api/wake", "/ws", "/ws/pty"}
		if s.config.Engine {
			endpoints = []string{s.config.Prefix + "/sessions", s.config.Prefix + "/capture", s.config.Prefix + "/send", s.config.Prefix + "/wake", s.config.Prefix + "/ws", s.config.Prefix + "/ws/pty"}
		}
		writeJSON(w, 200, map[string]any{"version": "herdr-core-dev", "node": s.config.Node, "host": "localhost", "agents": []string{}, "uptime": int(time.Since(s.started).Seconds()), "clockUtc": time.Now().UTC().Format(time.RFC3339), "endpoints": endpoints, "capabilities": []string{"sessions", "capture", "agent-prompt", "dashboard-ws", "terminal-stream", "existing-pane-wake"}})
	case "/api/config":
		if r.URL.RawQuery != "" || r.URL.ForceQuery {
			fail(w, 400, "config_query_not_supported")
			return
		}
		peers := s.publicConfig.NamedPeers
		if !s.publicConfig.HasPeers {
			c, err := readFederationConfig(false)
			if err != nil {
				fail(w, 503, "federation_unavailable")
				return
			}
			peers = []map[string]string{}
			for _, p := range c.peers {
				peers = append(peers, map[string]string{"name": p.Name, "url": p.URL})
			}
		}
		writeJSON(w, 200, map[string]any{"node": s.config.Node, "agents": s.publicConfig.Agents, "namedPeers": peers})
	case "/api/teams":
		if _, err := s.backend.Sessions(r.Context()); err != nil {
			backendFailure(w, err)
			return
		}
		home, err := os.UserHomeDir()
		if err != nil {
			fail(w, 503, "teams_unavailable")
			return
		}
		teams, err := readTeams(home, time.Now())
		if err != nil {
			fail(w, 503, "teams_unavailable")
			return
		}
		writeJSON(w, 200, map[string]any{"teams": teams, "total": len(teams)})
	case "/api/costs":
		writeJSON(w, 200, map[string]any{"agents": []any{}, "total": map[string]any{"tokens": 0, "cost": 0, "sessions": 0, "agents": 0}, "supported": false})
	case "/api/feed":
		limit := -1
		if raw, present := r.URL.Query()["limit"]; present {
			if len(raw) != 1 || raw[0] == "" {
				fail(w, 400, "invalid_limit")
				return
			}
			for _, c := range raw[0] {
				if c < '0' || c > '9' {
					fail(w, 400, "invalid_limit")
					return
				}
			}
			n, err := strconv.ParseUint(raw[0], 10, 64)
			if err != nil {
				fail(w, 400, "invalid_limit")
				return
			}
			if n > 200 {
				n = 200
			}
			limit = int(n)
		}
		writeJSON(w, 200, s.deliveryHistory.snapshot(limit))
	case "/api/health", "/health":
		if _, err := s.backend.Sessions(r.Context()); err != nil {
			writeJSON(w, 503, map[string]any{"ok": false, "error": "herdr_unavailable"})
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	default:
		fail(w, 404, "not_found")
	}
}

type sendRequest struct {
	Target      string    `json:"target"`
	Text        string    `json:"text"`
	Force       bool      `json:"force"`
	Inbox       bool      `json:"inbox"`
	Attachments []*string `json:"attachments"`
}

func (s *Server) serveSend(w http.ResponseWriter, r *http.Request) {
	var body sendRequest
	if !decodeJSON(w, r, &body, 64<<10) {
		return
	}
	originalText := body.Text
	if len(body.Attachments) != 0 {
		parts := make([]string, 0, len(body.Attachments)+1)
		for _, attachment := range body.Attachments {
			if attachment == nil {
				fail(w, 400, "invalid_json")
				return
			}
			parts = append(parts, *attachment)
		}
		body.Text = strings.Join(append(parts, body.Text), "\n")
	}
	if strings.TrimSpace(body.Target) == "" {
		s.deliveryHistory.append(deliveryEvent{Timestamp: time.Now().Unix(), Kind: "message", Direction: "inbound", State: "failed", Route: "validate", Target: body.Target, Text: body.Text, Source: "herdr", Error: "empty-target"})
		writeJSON(w, 400, map[string]any{"ok": false, "error": "empty-target", "state": "failed"})
		return
	}
	if !body.Inbox && body.Text == "" {
		fail(w, 400, "target_and_text_required")
		return
	}
	if body.Inbox {
		s.serveInbox(w, r, body, originalText)
		return
	}
	if body.Force {
		fail(w, 501, "send_options_not_supported")
		return
	}
	key, owner, proceed := s.claimDelivery(w, r, body.Target, body.Text, body.Text, "local")
	if !proceed {
		return
	}
	defer s.delivery.cancel(key, owner)
	if err := s.backend.Send(r.Context(), body.Target, body.Text); err != nil {
		s.recordDelivery(r, body.Target, body.Text, "local", "failed")
		backendFailure(w, err)
		return
	}
	s.delivery.complete(key, owner, "accepted", time.Now())
	s.recordDelivery(r, body.Target, body.Text, "local", "accepted")
	writeJSON(w, 200, map[string]any{"ok": true, "target": body.Target, "text": body.Text, "source": "local", "lastLine": "", "state": "accepted", "receipt": []string{"herdr agent prompt accepted"}, "warning": "Prompt acceptance does not imply consumption or completion; this path does not queue an inbox message."})
}
