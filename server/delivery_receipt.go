package main

import (
	"net/http"
	"strconv"
	"strings"
	"time"
)

// claimDelivery validates live canonical targets before replaying a receipt.
// Timestamp headers are correlation metadata under operator auth, not signatures.
func (s *Server) claimDelivery(w http.ResponseWriter, r *http.Request, target, text, responseText, source string) ([32]byte, *deliveryClaim, bool) {
	logical := strings.TrimSpace(r.Header.Get("X-Maw-Timestamp"))
	if logical == "" {
		logical = strings.TrimSpace(r.Header.Get("X-Maw-Signed-At"))
	}
	if logical == "" {
		return [32]byte{}, nil, true
	}
	if len(logical) > 1024 || len(r.Header.Get("X-Maw-From")) > 1024 {
		fail(w, 400, "invalid_delivery_metadata")
		return [32]byte{}, nil, false
	}
	sessions, err := s.backend.Sessions(r.Context())
	if err != nil {
		backendFailure(w, err)
		return [32]byte{}, nil, false
	}
	found := false
	for _, session := range sessions {
		for _, window := range session.Windows {
			if session.Name+":"+strconv.Itoa(window.Index) == target {
				found = true
			}
		}
	}
	if !found {
		backendFailure(w, ErrTargetNotFound)
		return [32]byte{}, nil, false
	}
	from := strings.TrimSpace(r.Header.Get("X-Maw-From"))
	if from == "" {
		config, err := loadMergedConfig(s.configRoot)
		if err != nil {
			fail(w, 503, "config_unavailable")
			return [32]byte{}, nil, false
		}
		from = inboxDisplaySender(r.Context(), "", s.configRoot, config)
	}
	key, _ := deliveryKey(from, target, logical, text)
	owner, state, err := s.delivery.claim(key, time.Now())
	if err != nil {
		fail(w, 429, "delivery_capacity_reached")
		return key, nil, false
	}
	if owner == nil {
		reason := "duplicate delivery dropped by idempotency key"
		writeJSON(w, 200, map[string]any{"ok": true, "target": target, "text": responseText, "source": source, "state": state, "deduped": true, "idempotent": true, "reason": reason, "lastLine": reason, "receipt": []string{"duplicate_dropped"}})
		return key, nil, false
	}
	return key, owner, true
}
