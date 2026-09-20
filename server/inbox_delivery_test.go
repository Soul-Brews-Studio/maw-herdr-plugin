package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInboxGate(t *testing.T) {
	for _, v := range []string{"1", "true", "YES", " on "} {
		t.Setenv("MAW_TEST_MODE", "1")
		t.Setenv("MAW_HEY_INBOX_AUTOWRITE", v)
		if !inboxEnabled() {
			t.Fatal(v)
		}
	}
	for _, v := range []string{"0", "false", "NO", " off "} {
		t.Setenv("MAW_TEST_MODE", "")
		t.Setenv("MAW_HEY_INBOX_AUTOWRITE", v)
		if inboxEnabled() {
			t.Fatal(v)
		}
	}
	t.Setenv("MAW_HEY_INBOX_AUTOWRITE", "other")
	t.Setenv("MAW_TEST_MODE", "1")
	if inboxEnabled() {
		t.Fatal("test default")
	}
}
func TestInboxNativeQueue(t *testing.T) {
	t.Setenv("HOME", federationTempDir(t))
	t.Setenv("MAW_ORACLES_JSON", filepath.Join(federationTempDir(t), "missing"))
	t.Setenv("MAW_HEY_INBOX_AUTOWRITE", "1")
	root := federationTempDir(t)
	b, calls, snapshot := testBackend(t)
	*snapshot = strings.ReplaceAll(strings.ReplaceAll(backendSnapshot, "/tmp", root), `"agent":"codex"`, `"agent":null`)
	path, err := b.QueueInbox(context.Background(), "bWFpbg/d0Q:4", "node:sender", "hello", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(raw), "to: demo\n") {
		t.Fatal(string(raw), err)
	}
	if len(*calls) != 4 {
		t.Fatal(*calls)
	}
	original := b.run
	n := 0
	b.run = func(ctx context.Context, args ...string) ([]byte, error) {
		if len(args) > 3 && args[3] == "snapshot" {
			n++
			if n == 2 {
				*snapshot = strings.ReplaceAll(*snapshot, root, federationTempDir(t))
			}
		}
		return original(ctx, args...)
	}
	if _, err = b.QueueInbox(context.Background(), "bWFpbg/d0Q:4", "node:sender", "stale", "", nil); err == nil {
		t.Fatal("stale accepted")
	}
}
func TestInboxHTTPOriginalAndOverride(t *testing.T) {
	t.Setenv("HOME", federationTempDir(t))
	t.Setenv("MAW_HEY_INBOX_AUTOWRITE", "1")
	t.Setenv("MAW_ORACLES_JSON", filepath.Join(federationTempDir(t), "missing"))
	s, _ := testServer(t)
	b, calls, snapshot := testBackend(t)
	root := federationTempDir(t)
	override := federationTempDir(t)
	*snapshot = strings.ReplaceAll(backendSnapshot, "/tmp", root)
	s.backend = b
	s.configRoot = federationTempDir(t)
	os.Mkdir(filepath.Join(s.configRoot, ".maw"), 0700)
	cfg, _ := json.Marshal(map[string]string{"oracle": "demo-oracle", "psiPath": filepath.Join(override, "ψ")})
	os.WriteFile(filepath.Join(s.configRoot, ".maw", "maw.config.50.json"), cfg, 0600)
	w := request(s, "POST", "/api/send", `{"target":"bWFpbg/d0Q:4","text":"hello","attachments":["attachment"],"inbox":true,"force":true}`, map[string]string{"X-Maw-From": " sender : remote "})
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var body map[string]any
	json.Unmarshal(w.Body.Bytes(), &body)
	if body["text"] != "hello" || body["source"] != "inbox" || body["state"] != "queued" {
		t.Fatal(body)
	}
	path := body["inbox"].(string)
	if !strings.HasPrefix(path, override+"/") {
		t.Fatal(path)
	}
	raw, _ := os.ReadFile(path)
	if !strings.Contains(string(raw), "from: remote:sender\n") || !strings.Contains(string(raw), "attachment\nhello") {
		t.Fatal(string(raw))
	}
	if len(*calls) != 6 {
		t.Fatal(*calls)
	}
	history := s.deliveryHistory.snapshot(-1)
	if history.Total != 1 || history.Events[0].State != "queued" || history.Events[0].Route != "inbox" || history.Events[0].Text != "attachment\nhello" {
		t.Fatal(history)
	}

}
