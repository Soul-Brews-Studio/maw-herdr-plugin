package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInboxSenderPrecedence(t *testing.T) {
	t.Setenv("TMUX_PANE", "")
	t.Setenv("MAW_SESSION_WINDOW", "")
	old, had := os.LookupEnv("TMUX")
	os.Unsetenv("TMUX")
	t.Cleanup(func() {
		if had {
			os.Setenv("TMUX", old)
		}
	})
	root := t.TempDir()
	cfg := map[string]any{"node": "server", "oracle": "configured-oracle"}
	ctx := context.Background()
	if got := inboxDisplaySender(ctx, "", root, cfg); got != "server:configured-oracle" {
		t.Fatal(got)
	}
	t.Setenv("MAW_SESSION_WINDOW", "session:window.2")
	if got := inboxSenderOracle(ctx, root, cfg); got != "window" {
		t.Fatal(got)
	}
	os.WriteFile(filepath.Join(root, "CLAUDE.md"), []byte("# Oracle: marked-oracle (context)\n"), 0600)
	if got := inboxSenderOracle(ctx, root, cfg); got != "marked" {
		t.Fatal(got)
	}
	os.WriteFile(filepath.Join(root, "CLAUDE.md"), []byte(strings.Repeat("blank\n", 120)+"Oracle: ignored\n"), 0600)
	if got := inboxSenderOracle(ctx, root, cfg); got != "window" {
		t.Fatal(got)
	}
	t.Setenv("MAW_SESSION_WINDOW", "")
	if got := inboxSenderOracle(ctx, root, nil); got != "pane/unknown" {
		t.Fatal(got)
	}
	os.Mkdir(filepath.Join(root, ".git"), 0700)
	if got := inboxSenderOracle(ctx, root, nil); got != "job/"+filepath.Base(root) {
		t.Fatal(got)
	}
	for raw, want := range map[string]string{" a : b:c ": "b:c:a", " raw ": "raw", " :node ": ":node"} {
		if got := inboxDisplaySender(ctx, raw, root, cfg); got != want {
			t.Fatal(got, want)
		}
	}
}
