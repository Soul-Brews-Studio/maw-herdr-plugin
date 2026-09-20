package main

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

func (s *Server) serveFeedActivity(w http.ResponseWriter, r *http.Request) {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
	if err != nil {
		fail(w, 400, "invalid_feed_body")
		return
	}
	var body map[string]any
	if utf8.Valid(data) && json.Unmarshal(data, &body) == nil {
		if oracle, ok := body["oracle"].(string); ok && strings.TrimSpace(oracle) != "" {
			if len(oracle) > 1024 {
				fail(w, 400, "invalid_feed_oracle")
				return
			}
			if !s.observed.markActivity(oracle, time.Now()) {
				fail(w, 429, "feed_activity_capacity_reached")
				return
			}
		}
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}
