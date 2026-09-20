package main

import (
	"context"
	"errors"
	"strings"
	"time"
)

type inputBackend interface {
	Input(context.Context, string, string, bool) error
}

func (b *HerdrBackend) Input(ctx context.Context, target, text string, enter bool) error {
	if len(text) > 64<<10 || strings.ContainsRune(text, 0) {
		return errors.New("invalid terminal input")
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	pane, err := b.resolve(ctx, target)
	if err != nil {
		return err
	}
	if _, err = b.run(ctx, "--session", pane.session, "pane", "send-text", pane.pane.ID, text); err != nil {
		return err
	}
	if enter {
		_, err = b.run(ctx, "--session", pane.session, "pane", "send-keys", pane.pane.ID, "enter")
	}
	return err
}
