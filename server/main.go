package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "maw herdr serve:", err)
		os.Exit(1)
	}
}

func run() error {
	flags := flag.NewFlagSet("maw herdr serve", flag.ContinueOnError)
	engine := flags.Bool("engine", false, "run as a loopback maw engine.serve child")
	listen := flags.String("listen", "127.0.0.1:3457", "loopback address and port")
	tokenFile := flags.String("token-file", "", "required operator token file (at least 16 bytes; mode 0600)")
	wakeEngine := flags.String("wake-engine", "claude", "Herdr agent kind for dashboard wake")
	binary := flags.String("herdr", "herdr", "Herdr executable")
	dataDir := flags.String("data-dir", "", "private UI-state directory (default: user config/maw-herdr/serve)")
	if err := flags.Parse(os.Args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected positional arguments")
	}
	config := Config{}
	if *engine {
		explicit := map[string]bool{}
		flags.Visit(func(f *flag.Flag) { explicit[f.Name] = true })
		var err error
		config, *listen, err = engineConfig(os.Getenv, explicit)
		if err != nil {
			return err
		}
	} else {
		host, _, err := net.SplitHostPort(*listen)
		if err != nil || !loopbackHost(host) {
			return errors.New("--listen must use a loopback IP or localhost and port")
		}
		if *tokenFile == "" {
			return errors.New("--token-file is required; never pass operator tokens on the command line")
		}
		info, err := os.Stat(*tokenFile)
		if err != nil {
			return fmt.Errorf("token file: %w", err)
		}
		if !info.Mode().IsRegular() || info.Size() > 4096 || info.Mode().Perm()&0077 != 0 {
			return errors.New("token file must be a regular file <=4096 bytes, readable only by its owner (chmod 600)")
		}
		secret, err := os.ReadFile(*tokenFile)
		if err != nil {
			return fmt.Errorf("token file: %w", err)
		}
		config.Token = strings.TrimSpace(string(secret))
	}
	if *dataDir == "" {
		dir, err := os.UserConfigDir()
		if err != nil {
			return err
		}
		*dataDir = filepath.Join(dir, "maw-herdr", "serve")
	}
	if !validWakeEngine(*wakeEngine) {
		return errors.New("--wake-engine must be a supported Herdr agent kind")
	}
	config.WakeEngine = *wakeEngine
	flags.Visit(func(f *flag.Flag) {
		if f.Name == "wake-engine" {
			config.WakeEngineExplicit = true
		}
	})
	config.DataDir = *dataDir
	server, err := NewServer(config, NewHerdrBackend(*binary))
	if err != nil {
		return err
	}
	defer server.Close()
	listener, err := net.Listen("tcp", *listen)
	if err != nil {
		return err
	}
	httpServer := &http.Server{Handler: server, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 20 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		server.Close()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdown)
	}()
	if config.Engine {
		fmt.Fprintf(os.Stderr, "maw herdr serve: http://%s%s (engine child; local processes trusted; gateway authenticates remote clients)\n", listener.Addr(), config.Prefix)
	} else {
		fmt.Fprintf(os.Stderr, "maw herdr serve: http://%s (operator token required; core dashboard only)\n", listener.Addr())
	}
	if err := httpServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
