package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestReceiverInboxWriter(t *testing.T) {
	root := federationTempDir(t)
	now := time.Date(2026, 6, 28, 5, 18, 0, 0, time.UTC)
	first, err := writeReceiverInbox(root, "target", "node:sender", "Hello World", now)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(first) != "2026-06-28_05-18_node-sender_hello-world.md" {
		t.Fatal(first)
	}
	body, err := os.ReadFile(first)
	if err != nil {
		t.Fatal(err)
	}
	want := "---\nfrom: node:sender\nto: target\ntimestamp: 2026-06-28T05:18:00.000Z\nread: false\n---\n\nHello World\n"
	if string(body) != want {
		t.Fatalf("%q", body)
	}
	second, err := writeReceiverInbox(root, "target", "node:sender", "Hello World", now)
	if err != nil || second != strings.TrimSuffix(first, ".md")+"-2.md" {
		t.Fatalf("%s %v", second, err)
	}
	st, _ := os.Stat(first)
	if st.Mode().Perm() != 0600 {
		t.Fatal(st.Mode())
	}
	entries, _ := os.ReadDir(filepath.Dir(first))
	if len(entries) != 2 {
		t.Fatal(entries)
	}
	for _, bad := range []string{"", "x\nread: true", "x\rfoo", "x\x00", strings.Repeat("x", 1025)} {
		if _, err := writeReceiverInbox(root, "target", bad, "body", now); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
	if _, err := writeReceiverInbox(root, "target", "sender", strings.Repeat("x", (64<<10)+1), now); err == nil {
		t.Fatal("oversize accepted")
	}
}
func TestReceiverInboxRejectsSymlink(t *testing.T) {
	root, out := federationTempDir(t), federationTempDir(t)
	if err := os.Symlink(out, filepath.Join(root, "ψ")); err != nil {
		t.Fatal(err)
	}
	if _, err := writeReceiverInbox(root, "target", "sender", "body", time.Now()); err == nil {
		t.Fatal("symlink accepted")
	}
	entries, _ := os.ReadDir(out)
	if len(entries) != 0 {
		t.Fatal("outside mutated")
	}
}
