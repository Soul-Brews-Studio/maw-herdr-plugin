package main

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
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
	if r.URL.Path == "/api/ui-state" || r.URL.Path == "/api/asks" {
		s.serveState(w, r)
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
	if r.Method != "GET" {
		methodNotAllowed(w, "GET")
		return
	}
	switch r.URL.Path {
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
			writeJSON(w, 200, map[string]string{"content": "", "error": "capture_unavailable"})
			return
		}
		writeJSON(w, 200, map[string]string{"content": content})
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
		endpoints := []string{"/api/sessions", "/api/capture", "/api/send", "/ws"}
		if s.config.Engine {
			endpoints = []string{s.config.Prefix + "/sessions", s.config.Prefix + "/capture", s.config.Prefix + "/send", s.config.Prefix + "/ws"}
		}
		writeJSON(w, 200, map[string]any{"version": "herdr-core-dev", "node": s.config.Node, "host": "localhost", "agents": []string{}, "uptime": int(time.Since(s.started).Seconds()), "clockUtc": time.Now().UTC().Format(time.RFC3339), "endpoints": endpoints, "capabilities": []string{"sessions", "capture", "agent-prompt", "dashboard-ws"}})
	case "/api/config":
		if r.URL.RawQuery != "" || r.URL.ForceQuery {
			fail(w, 400, "config_query_not_supported")
			return
		}
		writeJSON(w, 200, map[string]any{"node": s.config.Node, "agents": map[string]any{}, "namedPeers": []any{}})
	case "/api/teams":
		writeJSON(w, 200, map[string]any{"teams": []any{}, "total": 0, "supported": false})
	case "/api/costs":
		writeJSON(w, 200, map[string]any{"agents": []any{}, "total": map[string]any{"tokens": 0, "cost": 0, "sessions": 0, "agents": 0}, "supported": false})
	case "/api/feed":
		writeJSON(w, 200, map[string]any{"events": []any{}, "total": 0, "active_oracles": []string{}, "supported": false})
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
	Target      string   `json:"target"`
	Text        string   `json:"text"`
	Force       bool     `json:"force"`
	Inbox       bool     `json:"inbox"`
	Attachments []string `json:"attachments"`
}

func (s *Server) serveSend(w http.ResponseWriter, r *http.Request) {
	var body sendRequest
	if !decodeJSON(w, r, &body, 64<<10) {
		return
	}
	if body.Target == "" || body.Text == "" {
		fail(w, 400, "target_and_text_required")
		return
	}
	if body.Force || body.Inbox || len(body.Attachments) != 0 {
		fail(w, 501, "send_options_not_supported")
		return
	}
	if err := s.backend.Send(r.Context(), body.Target, body.Text); err != nil {
		backendFailure(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "target": body.Target, "text": body.Text, "source": "local", "lastLine": "", "state": "accepted", "receipt": []string{"herdr agent prompt accepted"}, "warning": "Acceptance is not proof the agent consumed or completed this prompt; queue/inbox delivery is not implemented."})
}
