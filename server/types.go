package main

import "context"

type Backend interface {
	Sessions(context.Context) ([]Session, error)
	Capture(context.Context, string, int) (string, error)
	CaptureBatch(context.Context, map[string]int) (map[string]string, error)
	Send(context.Context, string, string) error
}

type Session struct {
	Name    string   `json:"name"`
	Windows []Window `json:"windows"`
	Source  string   `json:"source"`
}
type Window struct {
	Index  int    `json:"index"`
	Name   string `json:"name"`
	Active bool   `json:"active"`
	Cwd    string `json:"cwd,omitempty"`
	Status string `json:"status,omitempty"`
}
