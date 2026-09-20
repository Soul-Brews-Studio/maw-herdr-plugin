package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

var ErrWakeBusy = errors.New("wake capacity reached")

type wakeBackend interface {
	Wake(context.Context, string) (string, error)
}

func validWakeEngine(kind string) bool {
	switch kind {
	case "pi", "claude", "codex", "gemini", "cursor", "devin", "agy", "cline", "omp", "mastracode", "opencode", "copilot", "kimi", "kiro", "droid", "amp", "grok", "hermes", "kilo", "qodercli", "qwen", "maki", "muse":
		return true
	default:
		return false
	}
}
func (s *Server) serveWake(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Target  string `json:"target"`
		Task    string `json:"task"`
		Command string `json:"command"`
	}
	if !decodeJSON(w, r, &body, 64<<10) {
		return
	}
	if body.Target == "" || len(body.Target) > 1024 {
		fail(w, 400, "target_required")
		return
	}
	if body.Task != "" {
		fail(w, 501, "task_wake_not_supported")
		return
	}
	backend, ok := s.backend.(wakeBackend)
	if !ok {
		fail(w, 501, "wake_not_supported")
		return
	}
	state, err := backend.Wake(r.Context(), body.Target)
	if err != nil {
		backendFailure(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "target": body.Target, "state": state})
}

func (b *HerdrBackend) Wake(ctx context.Context, target string) (string, error) {
	if target == "" || len(target) > 1024 {
		return "", ErrTargetNotFound
	}
	select {
	case b.wakeSlots <- struct{}{}:
		defer func() { <-b.wakeSlots }()
	default:
		return "", ErrWakeBusy
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	roster, err := b.roster(ctx)
	if err != nil {
		return "", err
	}
	pane, found := roster.targets[target]
	if found && strings.TrimSpace(pane.pane.Agent) != "" {
		return "already-awake", nil
	}
	select {
	case b.registryWakeGate <- struct{}{}:
		defer func() { <-b.registryWakeGate }()
	case <-ctx.Done():
		return "", ctx.Err()
	}
	if found {
		pane, err = b.resolve(ctx, target)
	} else {
		pane, err = b.resolveRegistryWake(ctx, target)
	}
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(pane.pane.Agent) != "" {
		return "already-awake", nil
	}
	kind := b.wakeEngine
	if kind == "" {
		kind = "claude"
	}
	if !validWakeEngine(kind) {
		return "", errors.New("invalid wake engine")
	}
	hash := sha256.Sum256([]byte(pane.pane.ID))
	name := fmt.Sprintf("maw-%x", hash[:8])
	raw, err := b.run(ctx, "--session", pane.session, "agent", "start", name, "--kind", kind, "--pane", pane.pane.ID, "--timeout", "8000")
	if err != nil {
		return "", err
	}
	raw, err = unwrapBackend(raw)
	if err != nil {
		return "", err
	}
	var response struct {
		Type  string `json:"type"`
		Agent struct {
			Pane    string `json:"pane_id"`
			Kind    string `json:"agent"`
			Ready   bool   `json:"interactive_ready"`
			Pending bool   `json:"launch_pending"`
		} `json:"agent"`
		Argv *[]string `json:"argv"`
	}
	if json.Unmarshal(raw, &response) != nil || response.Type != "agent_started" || response.Agent.Pane != pane.pane.ID || response.Agent.Kind != kind || !response.Agent.Ready || response.Agent.Pending || response.Argv == nil {
		return "", errors.New("invalid agent readiness response")
	}
	return "ready", nil
}
