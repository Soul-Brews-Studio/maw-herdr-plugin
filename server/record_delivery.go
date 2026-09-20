package main

import (
	"net/http"
	"strconv"
	"strings"
	"time"
)

func (s *Server) recordDelivery(r *http.Request, target, text, route, state string) {
	// Resolve the display identity from Herdr, never decode opaque target IDs.
	oracle := ""
	if sessions, err := s.backend.Sessions(r.Context()); err == nil {
		for _, session := range sessions {
			for _, window := range session.Windows {
				if session.Name+":"+strconv.Itoa(window.Index) == target {
					oracle = window.Name
				}
			}
		}
	}
	kind := "context.message"
	if state == "failed" {
		kind = "message"
	}
	s.deliveryHistory.append(deliveryEvent{Timestamp: time.Now().Unix(), Kind: kind, Direction: "inbound", State: state, Route: route, From: strings.TrimSpace(r.Header.Get("X-Maw-From")), To: oracle, Target: target, Text: text, Oracle: oracle, Source: "herdr"})
}
