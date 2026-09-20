package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"
)

// writeReceiverInbox publishes a complete legacy-readable message without
// overwriting existing entries. The repository directory is operator-trusted.
func writeReceiverInbox(base, oracle, from, message string, now time.Time) (string, error) {
	invalid := errors.New("receiver inbox unavailable")
	for _, value := range []string{oracle, from} {
		if strings.TrimSpace(value) == "" || len(value) > 1024 || !utf8.ValidString(value) || strings.ContainsAny(value, "\r\n\x00") {
			return "", invalid
		}
	}
	if len(message) > 64<<10 || !utf8.ValidString(message) || strings.ContainsRune(message, 0) || !filepath.IsAbs(base) {
		return "", invalid
	}
	root, err := filepath.EvalSymlinks(base)
	if err != nil {
		return "", invalid
	}
	st, err := os.Stat(root)
	if err != nil || !st.IsDir() {
		return "", invalid
	}
	dir := root
	for _, part := range []string{"ψ", "inbox"} {
		dir = filepath.Join(dir, part)
		if err = os.Mkdir(dir, 0700); err != nil && !os.IsExist(err) {
			return "", invalid
		}
		st, err = os.Lstat(dir)
		if err != nil || !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
			return "", invalid
		}
	}
	safe := func(value string) string {
		var out strings.Builder
		dash := false
		for _, ch := range strings.TrimSpace(value) {
			if ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' || ch == '_' || ch == '.' || ch == '-' {
				out.WriteRune(ch)
				dash = false
			} else if !dash {
				out.WriteByte('-')
				dash = true
			}
		}
		text := strings.Trim(out.String(), "-")
		if len(text) > 64 {
			text = text[:64]
		}
		if text == "" {
			text = "unknown"
		}
		return text
	}
	words := strings.Fields(message)
	if len(words) > 6 {
		words = words[:6]
	}
	slug := strings.Join(words, "-")
	slug = strings.Map(func(ch rune) rune {
		if ch >= 'A' && ch <= 'Z' {
			return ch + 32
		}
		return ch
	}, slug)
	slug = safe(slug)
	if len(slug) > 48 {
		slug = slug[:48]
	}
	now = now.UTC()
	stem := now.Format("2006-01-02_15-04") + "_" + safe(from) + "_" + slug
	body := fmt.Sprintf("---\nfrom: %s\nto: %s\ntimestamp: %s\nread: false\n---\n\n%s\n", from, oracle, now.Format("2006-01-02T15:04:05.000Z"), message)
	file, err := os.CreateTemp(dir, ".inbox-*")
	if err != nil {
		return "", invalid
	}
	defer os.Remove(file.Name())
	_, err = file.WriteString(body)
	closeErr := file.Close()
	if err != nil || closeErr != nil {
		return "", invalid
	}
	for attempt := 1; attempt <= 1000; attempt++ {
		name := stem
		if attempt > 1 {
			name += fmt.Sprintf("-%d", attempt)
		}
		path := filepath.Join(dir, name+".md")
		if err = os.Link(file.Name(), path); err == nil {
			return path, nil
		} else if !os.IsExist(err) {
			return "", invalid
		}
	}
	return "", invalid
}
