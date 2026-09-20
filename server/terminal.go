package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"time"
)

type terminalInput struct {
	Type  string `json:"type"`
	Bytes string `json:"bytes,omitempty"`
	Cols  int    `json:"cols,omitempty"`
	Rows  int    `json:"rows,omitempty"`
}

// stderr is private; overflow cancels the controller instead of leaving it
// blocked on a pipe whose bounded reader has stopped.
type terminalStderr struct {
	output limitedOutput
	cancel context.CancelFunc
}

func (w *terminalStderr) Write(data []byte) (int, error) {
	n, err := w.output.Write(data)
	if err != nil {
		w.cancel()
	}
	return n, err
}

type terminalBackend interface {
	Terminal(context.Context, string, int, int, <-chan terminalInput, func([]byte) error) error
}

func terminalSize(cols, rows int) bool { return cols >= 1 && cols <= 500 && rows >= 1 && rows <= 300 }

// Terminal controls an existing, freshly resolved pane. It never takes over an
// existing controller, creates a shell, or kills the underlying Herdr pane.
func (b *HerdrBackend) Terminal(ctx context.Context, target string, cols, rows int, input <-chan terminalInput, output func([]byte) error) error {
	if !terminalSize(cols, rows) {
		return errors.New("invalid terminal size")
	}
	pane, err := b.resolve(ctx, target)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := exec.CommandContext(ctx, b.binary, "--session", pane.session, "terminal", "session", "control", pane.pane.ID, "--cols", strconv.Itoa(cols), "--rows", strconv.Itoa(rows))
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = time.Second
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	defer stdin.Close()
	stdout, stdoutWriter, err := os.Pipe()
	if err != nil {
		return err
	}
	defer stdout.Close()
	defer stdoutWriter.Close()
	cmd.Stdout = stdoutWriter
	cmd.Stderr = &terminalStderr{output: limitedOutput{limit: 64 << 10}, cancel: cancel}
	if err = cmd.Start(); err != nil {
		return errors.New("terminal start failed")
	}
	// Wait must run independently of stdout consumption: a descendant may
	// inherit stdout after the controller exits. Allow bounded drain, then cancel.
	_ = stdoutWriter.Close()
	exited := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(exited)
		select {
		case <-ctx.Done():
		case <-time.After(time.Second):
			cancel()
		}
	}()
	cleaned := make(chan struct{})
	go func() {
		defer close(cleaned)
		<-ctx.Done()
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		_ = stdin.Close()
		_ = stdout.Close()
	}()
	defer func() { cancel(); <-cleaned; <-exited }()
	timer := time.AfterFunc(10*time.Second, cancel)
	defer timer.Stop()
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		encoder := json.NewEncoder(stdin)
		for {
			select {
			case <-ctx.Done():
				return
			case command, ok := <-input:
				if !ok {
					cancel()
					return
				}
				if encoder.Encode(command) != nil {
					cancel()
					return
				}
			}
		}
	}()
	defer func() { cancel(); stdin.Close(); <-writerDone }()
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 4096), 4<<20)
	for scanner.Scan() {
		var frame struct {
			Type     string `json:"type"`
			Bytes    string `json:"bytes"`
			Encoding string `json:"encoding"`
		}
		if json.Unmarshal(scanner.Bytes(), &frame) != nil {
			return errors.New("invalid terminal frame")
		}
		switch frame.Type {
		case "terminal.frame":
			if frame.Encoding != "ansi" {
				return errors.New("unsupported terminal encoding")
			}
			data, err := base64.StdEncoding.Strict().DecodeString(frame.Bytes)
			if err != nil || len(data) > 2<<20 {
				return errors.New("invalid terminal bytes")
			}
			timer.Stop()
			if err = output(data); err != nil {
				return err
			}
		case "terminal.closed":
			return nil
		default:
			return errors.New("unsupported terminal event")
		}
	}
	if err := scanner.Err(); err != nil {
		return errors.New("terminal stream failed")
	}
	return io.ErrUnexpectedEOF
}
