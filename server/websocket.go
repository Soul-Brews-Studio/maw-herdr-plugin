package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
)

type socketCommand struct {
	textPresent         bool
	targetExplicitEmpty bool
	Command             string   `json:"command"`
	Type                string   `json:"type"`
	Target              string   `json:"target"`
	Targets             []string `json:"targets"`
	Scope               string   `json:"scope"`
	Text                *string  `json:"text"`
	Content             *string  `json:"content"`
	Force               bool     `json:"force"`
	Inbox               bool     `json:"inbox"`
	Attachments         []string `json:"attachments"`
}

func (s *Server) serveWS(w http.ResponseWriter, r *http.Request, origin string) {
	if r.Method != "GET" {
		methodNotAllowed(w, "GET")
		return
	}
	if (!s.config.Engine && origin == "") || r.URL.RawQuery != "" || r.URL.ForceQuery {
		fail(w, 400, "websocket_request_invalid")
		return
	}
	if !s.config.Engine {
		// Exact spelling and exactly two offers. The second protocol is a single-use
		// credential, never negotiated or reflected. No URL/query-token fallback.
		values := r.Header.Values("Sec-WebSocket-Protocol")
		if len(values) != 1 {
			fail(w, 401, "websocket_ticket_required")
			return
		}
		parts := strings.Split(values[0], ",")
		if len(parts) != 2 || strings.TrimSpace(parts[0]) != protocol {
			fail(w, 401, "websocket_ticket_required")
			return
		}
		value := strings.TrimSpace(parts[1])
		if len(value) != 69 || !strings.HasPrefix(value, "mwt1_") || !s.consumeTicket(value, origin, r.URL.Path) {
			fail(w, 401, "websocket_ticket_invalid")
			return
		}
	}
	select {
	case s.sockets <- struct{}{}:
		defer func() { <-s.sockets }()
	default:
		fail(w, 503, "websocket_capacity_reached")
		return
	}
	// ServeHTTP already enforces the stricter exact Origin and Host policy.
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{protocol}, InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(64 << 10)
	if r.URL.Path == "/ws/pty" {
		s.servePTY(conn)
		return
	}
	ctx, cancel := context.WithCancel(s.context)
	defer cancel()
	commands := make(chan socketCommand, 8)
	go func() {
		defer cancel()
		for {
			kind, data, err := conn.Read(ctx)
			if err != nil {
				return
			}
			if kind != websocket.MessageText {
				_ = conn.Close(websocket.StatusUnsupportedData, "text JSON required")
				return
			}
			decoder := json.NewDecoder(bytes.NewReader(data))
			decoder.DisallowUnknownFields()
			var command socketCommand
			if decoder.Decode(&command) != nil || decoder.Decode(new(any)) != io.EOF {
				_ = conn.Close(websocket.StatusPolicyViolation, "invalid command JSON")
				return
			}
			// Preserve JSON presence: explicit empty target/null text must not
			// silently become a selected-target or content-alias mutation.
			var fields map[string]json.RawMessage
			_ = json.Unmarshal(data, &fields)
			_, command.textPresent = fields["text"]
			rawTarget, hasTarget := fields["target"]
			command.targetExplicitEmpty = hasTarget && command.Target == "" && !bytes.Equal(bytes.TrimSpace(rawTarget), []byte("null"))
			select {
			case commands <- command:
			case <-ctx.Done():
				return
			}
		}
	}()
	write := func(value any) bool {
		data, err := json.Marshal(value)
		if err != nil {
			return false
		}
		writeCtx, done := context.WithTimeout(ctx, 5*time.Second)
		defer done()
		return conn.Write(writeCtx, websocket.MessageText, data) == nil
	}
	errorFrame := func(reason string) bool { return write(map[string]any{"type": "error", "error": reason}) }
	lastSessions := ""
	available := map[string]bool{}
	roster := func(force bool) bool {
		sessions, err := s.backend.Sessions(ctx)
		if err != nil {
			errorFrame("herdr_unavailable")
			return false
		}
		available = map[string]bool{}
		for _, session := range sessions {
			for _, window := range session.Windows {
				available[session.Name+":"+strconv.Itoa(window.Index)] = true
			}
		}
		data, _ := json.Marshal(sessions)
		if !force && string(data) == lastSessions {
			return true
		}
		lastSessions = string(data)
		if !write(map[string]any{"type": "sessions", "sessions": sessions}) {
			return false
		}
		recent := []map[string]string{}
		for _, session := range sessions {
			for _, window := range session.Windows {
				recent = append(recent, map[string]string{"target": session.Name + ":" + strconv.Itoa(window.Index), "name": window.Name, "session": session.Name})
			}
		}
		return write(map[string]any{"type": "recent", "agents": recent})
	}
	if !write(map[string]any{"type": "feed-history", "events": []any{}}) || !roster(true) {
		return
	}
	selected, lastContent := "", ""
	haveContent := false
	previews := map[string]string{}
	previewSent := map[string]bool{}
	capture := func() bool {
		// Prune departed panes using the latest successful roster; one stale
		// preview must not freeze the selected pane and all remaining previews.
		departed := false
		if selected != "" && !available[selected] {
			selected = ""
			haveContent = false
			departed = true
		}
		for target := range previews {
			if !available[target] {
				delete(previews, target)
				delete(previewSent, target)
				departed = true
			}
		}
		if departed && !errorFrame("subscription_target_gone") {
			return false
		}
		targets := map[string]int{}
		for target := range previews {
			targets[target] = 15
		}
		if selected != "" {
			targets[selected] = 80
		}
		if len(targets) == 0 {
			return true
		}
		contents, err := s.backend.CaptureBatch(ctx, targets)
		if err != nil {
			return errorFrame("capture_unavailable")
		}
		if selected != "" {
			content := contents[selected]
			if !haveContent || content != lastContent {
				if !write(map[string]any{"type": "capture", "target": selected, "content": content}) {
					return false
				}
				lastContent, haveContent = content, true
			}
		}
		changed := map[string]string{}
		for target, previous := range previews {
			content := contents[target]
			if !previewSent[target] || content != previous {
				changed[target] = content
				previews[target] = content
				previewSent[target] = true
			}
		}
		return len(changed) == 0 || write(map[string]any{"type": "previews", "data": changed})
	}
	ticker := time.NewTicker(s.config.PollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if !roster(false) {
				continue
			} // Preserve the last good roster on backend failure.
			if !capture() {
				return
			}
		case command := <-commands:
			switch command.Type {
			case "select", "subscribe":
				if command.Target == "" || len(command.Target) > 1024 || (command.Scope != "" && command.Scope != "main" && command.Scope != "preview") {
					if !errorFrame("subscription_invalid") {
						return
					}
					continue
				}
				if command.Scope == "preview" {
					if _, exists := previews[command.Target]; !exists && len(previews) >= 16 {
						if !errorFrame("too_many_previews") {
							return
						}
						continue
					}
					previews[command.Target] = ""
					delete(previewSent, command.Target)
				} else {
					selected = command.Target
					haveContent = false
				}
				if !capture() {
					return
				}
			case "subscribe-previews":
				if len(command.Targets) > 16 {
					if !errorFrame("too_many_previews") {
						return
					}
					continue
				}
				valid := true
				for _, target := range command.Targets {
					if target == "" || len(target) > 1024 {
						valid = false
					}
				}
				if !valid {
					if !errorFrame("subscription_invalid") {
						return
					}
					continue
				}
				previews = map[string]string{}
				previewSent = map[string]bool{}
				for _, target := range command.Targets {
					previews[target] = ""
				}
				if !capture() {
					return
				}
			case "wake":
				if command.Command != "" {
					if !errorFrame("wake_command_not_supported") {
						return
					}
					continue
				}
				if command.Target == "" || len(command.Target) > 1024 {
					if !errorFrame("target_required") {
						return
					}
					continue
				}
				backend, ok := s.backend.(wakeBackend)
				if !ok {
					if !errorFrame("wake_not_supported") {
						return
					}
					continue
				}
				if _, err := backend.Wake(ctx, command.Target); err != nil {
					if !errorFrame("wake_failed") {
						return
					}
					continue
				}
				if !write(map[string]any{"type": "action-ok", "action": "wake", "target": command.Target}) {
					return
				}
			case "send":
				target := command.Target
				if target == "" && !command.targetExplicitEmpty {
					target = selected
				}
				text := command.Text
				if !command.textPresent {
					text = command.Content
				}
				if target == "" || len(target) > 1024 || text == nil {
					if !errorFrame("target_and_text_required") {
						return
					}
					continue
				}
				if command.Inbox || len(command.Attachments) > 0 {
					if !errorFrame("send_options_not_supported") {
						return
					}
					continue
				}
				backend, ok := s.backend.(inputBackend)
				if !ok {
					if !errorFrame("input_not_supported") {
						return
					}
					continue
				}
				if err := backend.Input(ctx, target, *text, command.Force); err != nil {
					if !errorFrame("send_failed") {
						return
					}
					continue
				}
				if !write(map[string]any{"type": "sent", "ok": true, "target": target, "text": *text, "state": "accepted"}) {
					return
				}

			default:
				if !errorFrame("command_not_supported") {
					return
				}
			}
		}
	}
}
