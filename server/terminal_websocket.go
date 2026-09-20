package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"time"

	"github.com/coder/websocket"
)

type terminalCommand struct {
	Type   string `json:"type"`
	Target string `json:"target,omitempty"`
	Cols   int    `json:"cols"`
	Rows   int    `json:"rows"`
}

func readTerminalCommand(data []byte) (terminalCommand, bool) {
	var command terminalCommand
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	valid := decoder.Decode(&command) == nil && decoder.Decode(new(any)) == io.EOF && terminalSize(command.Cols, command.Rows)
	return command, valid
}

func (s *Server) servePTY(conn *websocket.Conn) {
	ctx, cancel := context.WithCancel(s.context)
	defer cancel()
	backend, ok := s.backend.(terminalBackend)
	if !ok {
		_ = conn.Close(websocket.StatusPolicyViolation, "terminal unavailable")
		return
	}
	attachCtx, done := context.WithTimeout(ctx, 10*time.Second)
	kind, data, err := conn.Read(attachCtx)
	done()
	if err != nil {
		return
	}
	command, valid := readTerminalCommand(data)
	if kind != websocket.MessageText || !valid || command.Type != "attach" || command.Target == "" || len(command.Target) > 1024 {
		_ = conn.Close(websocket.StatusPolicyViolation, "attach required")
		return
	}
	input := make(chan terminalInput, 8)
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		defer cancel()
		for {
			kind, data, err := conn.Read(ctx)
			if err != nil {
				return
			}
			var message terminalInput
			if kind == websocket.MessageBinary {
				message = terminalInput{Type: "terminal.input", Bytes: base64.StdEncoding.EncodeToString(data)}
			} else {
				resize, valid := readTerminalCommand(data)
				if !valid || resize.Type != "resize" || resize.Target != "" {
					_ = conn.Close(websocket.StatusPolicyViolation, "resize required")
					return
				}
				message = terminalInput{Type: "terminal.resize", Cols: resize.Cols, Rows: resize.Rows}
			}
			select {
			case input <- message:
			case <-ctx.Done():
				return
			default:
				_ = conn.Close(websocket.StatusPolicyViolation, "terminal input queue full")
				return
			}
		}
	}()
	defer func() { cancel(); conn.CloseNow(); <-readerDone }()
	write := func(kind websocket.MessageType, data []byte) error {
		deadline, done := context.WithTimeout(ctx, 5*time.Second)
		defer done()
		return conn.Write(deadline, kind, data)
	}
	attached := false
	err = backend.Terminal(ctx, command.Target, command.Cols, command.Rows, input, func(data []byte) error {
		if !attached {
			if err := write(websocket.MessageText, []byte(`{"type":"attached"}`)); err != nil {
				return err
			}
			attached = true
		}
		return write(websocket.MessageBinary, data)
	})
	if ctx.Err() == nil {
		_ = write(websocket.MessageText, []byte(`{"type":"detached"}`))
		if err != nil {
			_ = conn.Close(websocket.StatusInternalError, "terminal unavailable")
		} else {
			_ = conn.Close(websocket.StatusNormalClosure, "terminal closed")
		}
	}
}
