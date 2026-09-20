package main

import (
	"context"
	"crypto/sha256"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const protocol = "maw.ws.v1"

type Config struct {
	WakeEngine         string
	WakeEngineExplicit bool
	Engine             bool
	Prefix             string
	Token              string
	Node               string
	DataDir            string
	PollInterval       time.Duration
}

type ticket struct {
	origin  string
	path    string
	expires time.Time
}

type Server struct {
	delivery           deliveryDedup
	deliveryHistory    deliveryFeed
	publicConfig       publicConfig
	configRoot         string
	federation         federationCache
	worktreeRoot       string
	worktreeSlots      chan struct{}
	observedRosterGate chan struct{}
	observed           observedFeed
	backend            Backend
	config             Config
	tokenHash          [32]byte
	started            time.Time
	mu                 sync.Mutex
	tickets            map[string]ticket
	stateMu            sync.Mutex
	context            context.Context
	cancel             context.CancelFunc
	sockets            chan struct{}
}

func NewServer(config Config, backend Backend) (*Server, error) {
	if len(config.Token) < 16 {
		return nil, errors.New("operator token must contain at least 16 bytes")
	}
	if config.Engine && config.Prefix != enginePrefix {
		return nil, errors.New("engine prefix must be /api/herdr")
	}
	if backend == nil {
		return nil, errors.New("backend required")
	}
	if config.WakeEngine == "" {
		config.WakeEngine = "codex"
	}
	if !validWakeEngine(config.WakeEngine) {
		return nil, errors.New("invalid wake engine")
	}
	if b, ok := backend.(*HerdrBackend); ok {
		b.wakeEngine = config.WakeEngine
		if config.WakeEngineExplicit {
			value := config.WakeEngine
			b.wakeEngineExplicit = &value
		}
	}
	if config.Node == "" {
		config.Node = "herdr"
	}
	if config.PollInterval <= 0 {
		config.PollInterval = time.Second
	}
	s := &Server{backend: backend, config: config, tokenHash: sha256.Sum256([]byte(config.Token)), started: time.Now(), tickets: make(map[string]ticket)}
	cwd, err := os.Getwd()
	if err != nil {
		return nil, err
	}
	s.worktreeRoot, err = filepath.EvalSymlinks(cwd)
	if err != nil {
		return nil, err
	}
	s.configRoot = s.worktreeRoot
	merged, err := loadMergedConfig(s.configRoot)
	if err != nil {
		return nil, err
	}
	s.publicConfig = projectPublicConfig(merged)
	s.config.Node = s.publicConfig.Node
	s.worktreeSlots = make(chan struct{}, 8)
	s.observedRosterGate = make(chan struct{}, 1)
	s.context, s.cancel = context.WithCancel(context.Background())
	s.sockets = make(chan struct{}, 32)
	s.config.Token = "" // Never retain credentials in the display/config structure.
	return s, nil
}

func (s *Server) Close() { s.cancel() }

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if s.config.Engine {
		s.serveEngine(w, r)
		return
	}
	if !loopbackHost(r.Host) {
		fail(w, 403, "host_not_allowed")
		return
	}
	origin, ok := requestOrigin(r)
	if !ok {
		fail(w, 403, "origin_not_allowed")
		return
	}
	if origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Add("Vary", "Origin")
	}
	if r.Method == http.MethodOptions {
		preflight(w, r, origin)
		return
	}
	if r.URL.Path == "/ws" || r.URL.Path == "/ws/pty" {
		s.serveWS(w, r, origin)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	if !s.authorized(r) {
		fail(w, 401, "operator_token_required")
		return
	}
	if r.URL.Path == "/api/auth/ws-ticket" {
		s.mintTicket(w, r, origin)
		return
	}
	s.serveAPI(w, r)
}
