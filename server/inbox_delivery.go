package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var errInboxUnavailable = errors.New("receiver inbox unavailable")

type backendInbox interface {
	QueueInbox(context.Context, string, string, string, string, map[string]any) (string, error)
}

func inboxEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("MAW_HEY_INBOX_AUTOWRITE"))) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	}
	return os.Getenv("MAW_TEST_MODE") != "1"
}

func (s *Server) serveInbox(w http.ResponseWriter, r *http.Request, body sendRequest, originalText string) {
	if !inboxEnabled() {
		fail(w, 503, "inbox_autowrite_disabled")
		return
	}
	b, ok := s.backend.(backendInbox)
	if !ok {
		fail(w, 501, "inbox_not_supported")
		return
	}
	config, err := loadMergedConfig(s.configRoot)
	if err != nil {
		fail(w, 503, "inbox_unavailable")
		return
	}
	from := inboxDisplaySender(r.Context(), r.Header.Get("X-Maw-From"), s.configRoot, config)
	key, owner, proceed := s.claimDelivery(w, r, body.Target, body.Text, originalText, "inbox")
	if !proceed {
		return
	}
	defer s.delivery.cancel(key, owner)
	path, err := b.QueueInbox(r.Context(), body.Target, from, body.Text, s.configRoot, config)
	if err != nil {
		s.recordDelivery(r, body.Target, body.Text, "inbox", "failed")
		backendFailure(w, err)
		return
	}
	s.delivery.complete(key, owner, "queued", time.Now())
	s.recordDelivery(r, body.Target, body.Text, "inbox", "queued")
	writeJSON(w, 200, map[string]any{"ok": true, "target": body.Target, "text": originalText, "source": "inbox", "state": "queued", "inbox": path, "reason": "--inbox requested; pane injection skipped", "receipt": []string{"fallback_queued"}})
}

func inboxNormalizeOracle(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if strings.Contains(value, ":") {
		parts := strings.FieldsFunc(value, func(r rune) bool { return r == ':' })
		if len(parts) >= 3 {
			value = parts[2]
		} else if len(parts) == 2 {
			value = parts[1]
		} else if len(parts) == 1 {
			value = parts[0]
		}
	}
	if i := strings.LastIndex(value, "."); i >= 0 && inboxDigits(value[i+1:]) {
		value = value[:i]
	}
	value = filepath.Base(value)
	value = strings.TrimSuffix(value, "-oracle")
	if a, b, ok := strings.Cut(value, "-"); ok && inboxDigits(a) {
		value = b
	}
	return value
}
func inboxDigits(s string) bool {
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

func (b *HerdrBackend) QueueInbox(ctx context.Context, target, from, message, serverRoot string, config map[string]any) (string, error) {
	if !inboxEnabled() {
		return "", errInboxUnavailable
	}
	first, err := b.resolve(ctx, target)
	if err != nil {
		return "", err
	}
	cwd, err := filepath.EvalSymlinks(first.pane.Cwd)
	if err != nil || !filepath.IsAbs(cwd) {
		return "", errInboxUnavailable
	}
	label := first.workspaceLabel
	if label == "" {
		label = first.pane.Label
	}
	if label == "" {
		label = first.pane.Title
	}
	if label == "" {
		label = first.pane.ID
	}
	base, oracle, err := resolveWakeIdentity(ctx, cwd, label)
	if err != nil {
		return "", errInboxUnavailable
	}
	oracle = inboxNormalizeOracle(oracle)
	configured, _ := config["oracle"].(string)
	psi, _ := config["psiPath"].(string)
	psi = strings.TrimSpace(psi)
	if psi != "" && oracle != "" && inboxNormalizeOracle(configured) == oracle {
		if !filepath.IsAbs(psi) {
			psi = filepath.Join(serverRoot, psi)
		}
		if filepath.Base(psi) == "ψ" || filepath.Base(psi) == "psi" {
			psi = filepath.Dir(psi)
		}
		if _, err := os.Stat(psi); err == nil {
			base = psi
		} else if !os.IsNotExist(err) {
			return "", errInboxUnavailable
		}
	}
	latest, err := b.resolve(ctx, target)
	if err != nil {
		return "", err
	}
	current, err := filepath.EvalSymlinks(latest.pane.Cwd)
	if err != nil || latest.session != first.session || latest.pane.ID != first.pane.ID || latest.pane.Workspace != first.pane.Workspace || current != cwd || latest.workspaceLabel != first.workspaceLabel || latest.pane.Label != first.pane.Label || latest.pane.Title != first.pane.Title {
		return "", ErrTargetNotFound
	}
	if ctx.Err() != nil {
		return "", errInboxUnavailable
	}
	return writeReceiverInbox(base, oracle, from, message, time.Now())
}
