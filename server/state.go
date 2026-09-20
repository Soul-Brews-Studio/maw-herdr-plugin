package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"unicode/utf8"
)

func (s *Server) serveState(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" && r.Method != "POST" {
		methodNotAllowed(w, "GET, POST")
		return
	}
	if s.config.DataDir == "" {
		fail(w, 503, "state_directory_required")
		return
	}
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	name, empty := "ui-state.json", "{}"
	if r.URL.Path == "/api/asks" {
		name, empty = "asks.json", "[]"
	}
	path := filepath.Join(s.config.DataDir, name)
	if r.Method == "GET" {
		// The configured directory may use platform aliases (e.g. /var on macOS).
		// Canonicalize it, but never follow the state-file leaf itself.
		directory, err := filepath.EvalSymlinks(s.config.DataDir)
		var data []byte
		if err == nil {
			data, err = federationRead(filepath.Join(directory, name), 256<<10)
		}
		if os.IsNotExist(err) || (err == nil && data == nil) {
			data, err = []byte(empty), nil
		}
		if err != nil || len(data) > 256<<10 || !validState(data, name) {
			fail(w, 500, "state_read_failed")
			return
		}
		writeJSON(w, 200, json.RawMessage(data))
		return
	}
	var value json.RawMessage
	if !decodeJSON(w, r, &value, 256<<10) {
		return
	}
	if !validState(value, name) {
		fail(w, 400, "state_shape_invalid")
		return
	}
	if err := os.MkdirAll(s.config.DataDir, 0700); err != nil {
		fail(w, 500, "state_write_failed")
		return
	}
	file, err := os.CreateTemp(s.config.DataDir, ".state-*")
	if err != nil {
		fail(w, 500, "state_write_failed")
		return
	}
	defer os.Remove(file.Name())
	_, err = file.Write(value)
	closeErr := file.Close()
	if err != nil || closeErr != nil {
		fail(w, 500, "state_write_failed")
		return
	}
	if err := os.Rename(file.Name(), path); err != nil {
		fail(w, 500, "state_write_failed")
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func validState(data []byte, name string) bool {
	var value any
	if !utf8.Valid(data) || json.Unmarshal(data, &value) != nil {
		return false
	}
	if name == "asks.json" {
		_, ok := value.([]any)
		return ok
	}
	_, ok := value.(map[string]any)
	return ok
}
