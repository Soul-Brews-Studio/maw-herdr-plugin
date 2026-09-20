package main

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestStateRejectsSymlinkReads(t *testing.T) {
	s, _ := testServer(t)
	outside := filepath.Join(federationTempDir(t), "private.json")
	if err := os.WriteFile(outside, []byte(`{"private":"not dashboard state"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(s.config.DataDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(s.config.DataDir, "ui-state.json")); err != nil {
		t.Fatal(err)
	}
	w := request(s, "GET", "/api/ui-state", "", nil)
	if w.Code != 500 {
		t.Fatalf("symlink read status %d", w.Code)
	}
}

func TestStateRejectsUnsafeFiles(t *testing.T) {
	for _, kind := range []string{"fifo", "directory", "oversized", "invalid-utf8", "truncated"} {
		t.Run(kind, func(t *testing.T) {
			s, _ := testServer(t)
			if err := os.MkdirAll(s.config.DataDir, 0700); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(s.config.DataDir, "ui-state.json")
			var err error
			switch kind {
			case "fifo":
				err = syscall.Mkfifo(path, 0600)
			case "directory":
				err = os.Mkdir(path, 0700)
			case "oversized":
				err = os.WriteFile(path, []byte(strings.Repeat(" ", (256<<10)+1)), 0600)
			case "invalid-utf8":
				err = os.WriteFile(path, []byte{'{', '"', 'x', '"', ':', '"', 255, '"', '}'}, 0600)
			case "truncated":
				err = os.WriteFile(path, []byte(`{"x":`), 0600)
			}
			if err != nil {
				t.Fatal(err)
			}
			if w := request(s, "GET", "/api/ui-state", "", nil); w.Code != 500 {
				t.Fatalf("%s status%d", kind, w.Code)
			}
		})
	}
}

func TestStateRejectsInvalidUTF8Writes(t *testing.T) {
	for _, route := range []string{"/api/ui-state", "/api/asks"} {
		t.Run(route, func(t *testing.T) {
			s, _ := testServer(t)
			good, bad := `{"x":"saved"}`, "{\"x\":\"\xff\"}"
			if route == "/api/asks" {
				good, bad = "["+good+"]", "["+bad+"]"
			}
			if w := request(s, "POST", route, good, nil); w.Code != 200 {
				t.Fatal(w.Code)
			}
			if w := request(s, "POST", route, bad, nil); w.Code != 400 {
				t.Fatalf("invalid UTF-8 status %d", w.Code)
			}
			if w := request(s, "GET", route, "", nil); w.Code != 200 || strings.TrimSpace(w.Body.String()) != good {
				t.Fatalf("saved state changed: %d %s", w.Code, w.Body.String())
			}
		})
	}
}
