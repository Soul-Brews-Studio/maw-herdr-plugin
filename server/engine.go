package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const enginePrefix = "/api/herdr"

// Called only for explicit --engine; environment alone never weakens standalone
// authentication. The gateway authenticates remote users; local processes are trusted.
func engineConfig(getenv func(string) string, explicit map[string]bool) (Config, string, error) {
	if explicit["listen"] || explicit["token-file"] {
		return Config{}, "", errors.New("--engine cannot be combined with --listen or --token-file")
	}
	token := strings.TrimSpace(getenv("MAW_SERVE_TOKEN"))
	if len(token) < 16 {
		return Config{}, "", errors.New("--engine requires MAW_SERVE_TOKEN with at least 16 bytes")
	}
	port := getenv("MAW_ENGINE_SERVE_PORT")
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 || strconv.Itoa(n) != port {
		return Config{}, "", errors.New("--engine requires MAW_ENGINE_SERVE_PORT in 1..65535")
	}
	if other := getenv("PORT"); other != "" && other != port {
		return Config{}, "", errors.New("PORT must match MAW_ENGINE_SERVE_PORT")
	}
	if getenv("MAW_ENGINE_SERVE_PREFIX") != enginePrefix {
		return Config{}, "", errors.New("MAW_ENGINE_SERVE_PREFIX must be /api/herdr")
	}
	return Config{Engine: true, Prefix: enginePrefix, Token: token}, net.JoinHostPort("127.0.0.1", port), nil
}

func (s *Server) serveEngine(w http.ResponseWriter, r *http.Request) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	ip := net.ParseIP(host)
	if err != nil || ip == nil || !ip.IsLoopback() || !loopbackHost(r.Host) {
		fail(w, http.StatusForbidden, "engine_loopback_required")
		return
	}
	// Even empty Origin is forbidden: browsers must use the gateway. Forwarded
	// headers never establish authority.
	if _, exists := r.Header["Origin"]; exists || len(r.Header.Values("Origin")) != 0 {
		fail(w, http.StatusForbidden, "engine_origin_not_allowed")
		return
	}
	path := r.URL.Path
	if path != s.config.Prefix && !strings.HasPrefix(path, s.config.Prefix+"/") {
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	suffix := strings.TrimPrefix(path, s.config.Prefix)
	if suffix == "/auth/ws-ticket" {
		fail(w, http.StatusNotImplemented, "engine_ws_ticket_not_supported")
		return
	}
	clone := r.Clone(r.Context())
	u := *r.URL
	clone.URL = &u
	clone.URL.RawPath = ""
	switch suffix {
	case "", "/":
		clone.URL.Path = "/api/identity"
	case "/ws", "/ws/pty":
		clone.URL.Path = suffix
		s.serveWS(w, clone, "")
		return
	case "/health":
		clone.URL.Path = "/health"
	default:
		clone.URL.Path = "/api" + suffix
	}
	ctx, cancel := context.WithTimeout(clone.Context(), 15*time.Second)
	defer cancel()
	s.serveAPI(w, clone.WithContext(ctx))
}
