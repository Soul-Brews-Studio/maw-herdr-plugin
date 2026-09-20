package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func loopbackHost(hostport string) bool {
	host := hostport
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		host = h
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

func requestOrigin(r *http.Request) (string, bool) {
	values := r.Header.Values("Origin")
	if len(values) == 0 {
		return "", true
	}
	if len(values) != 1 {
		return "", false
	}
	origin := values[0]
	u, err := url.Parse(origin)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.Host == "" || u.Path != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(origin, "#") || u.String() != origin {
		return "", false
	}
	return origin, origin == "https://god.buildwithoracle.com" || loopbackHost(u.Host)
}

func (s *Server) authorized(r *http.Request) bool {
	values := r.Header.Values("Authorization")
	if len(values) != 1 || !strings.HasPrefix(values[0], "Bearer ") {
		return false
	}
	actual := sha256.Sum256([]byte(strings.TrimPrefix(values[0], "Bearer ")))
	return subtle.ConstantTimeCompare(actual[:], s.tokenHash[:]) == 1
}

func preflight(w http.ResponseWriter, r *http.Request, origin string) {
	w.Header().Add("Vary", "Access-Control-Request-Method")
	w.Header().Add("Vary", "Access-Control-Request-Headers")
	w.Header().Add("Vary", "Access-Control-Request-Private-Network")
	methods := r.Header.Values("Access-Control-Request-Method")
	if origin == "" || len(methods) != 1 || (methods[0] != "GET" && methods[0] != "POST") {
		fail(w, 403, "preflight_not_allowed")
		return
	}
	headers := r.Header.Values("Access-Control-Request-Headers")
	if len(headers) > 1 {
		fail(w, 403, "preflight_not_allowed")
		return
	}
	seen := map[string]bool{}
	if len(headers) == 1 {
		for _, v := range strings.Split(headers[0], ",") {
			h := strings.ToLower(strings.TrimSpace(v))
			if (h != "authorization" && h != "content-type") || seen[h] {
				fail(w, 403, "preflight_not_allowed")
				return
			}
			seen[h] = true
		}
	}
	pna := r.Header.Values("Access-Control-Request-Private-Network")
	if len(pna) > 1 || (len(pna) == 1 && pna[0] != "true") {
		fail(w, 403, "preflight_not_allowed")
		return
	}
	if len(pna) == 1 {
		w.Header().Set("Access-Control-Allow-Private-Network", "true")
	}
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) mintTicket(w http.ResponseWriter, r *http.Request, origin string) {
	if r.Method != "POST" {
		methodNotAllowed(w, "POST")
		return
	}
	if origin == "" || r.URL.RawQuery != "" || r.URL.ForceQuery {
		fail(w, 400, "ticket_request_invalid")
		return
	}
	var body struct {
		Path string `json:"path"`
	}
	if !decodeJSON(w, r, &body, 128) {
		return
	}
	if body.Path != "/ws" && body.Path != "/ws/pty" {
		fail(w, 400, "ticket_path_invalid")
		return
	}
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		fail(w, 500, "ticket_generation_failed")
		return
	}
	value := "mwt1_" + hex.EncodeToString(raw[:])
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for k, v := range s.tickets {
		if !v.expires.After(now) {
			delete(s.tickets, k)
		}
	}
	if len(s.tickets) >= 256 {
		fail(w, 429, "too_many_tickets")
		return
	}
	s.tickets[value] = ticket{origin: origin, path: body.Path, expires: now.Add(30 * time.Second)}
	writeJSON(w, 200, map[string]string{"protocol": protocol, "ticket": value})
}

func (s *Server) consumeTicket(value, origin, path string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.tickets[value]
	if !ok || t.path != path || t.origin != origin || !t.expires.After(time.Now()) {
		return false
	}
	delete(s.tickets, value)
	return true
}
