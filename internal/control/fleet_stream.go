package control

import (
	"io"
	"net/http"
	"sync"
	"time"
)

type fleetChanges struct {
	mu   sync.Mutex
	next chan struct{}
}

func (c *fleetChanges) watch() <-chan struct{} {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.next
}

func (c *fleetChanges) notify() {
	c.mu.Lock()
	defer c.mu.Unlock()
	close(c.next)
	c.next = make(chan struct{})
}

const fleetChanged = "event: fleet\ndata: {}\n\n"

func (s *Server) streamFleet(w http.ResponseWriter, r *http.Request) {
	select {
	case s.fleetStreams <- struct{}{}:
		defer func() { <-s.fleetStreams }()
	default:
		w.Header().Set("Retry-After", "15")
		failure(w, http.StatusServiceUnavailable, "fleet_stream_limit")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store, no-transform")
	controller := http.NewResponseController(w)
	send := func(message string) bool {
		// Extend the server's initial write timeout only for each bounded flush.
		if controller.SetWriteDeadline(time.Now().Add(5*time.Second)) != nil {
			return false
		}
		_, err := io.WriteString(w, message)
		if err != nil || controller.Flush() != nil {
			return false
		}
		return controller.SetWriteDeadline(time.Time{}) == nil
	}

	next := s.fleetChanges.watch()
	if !send("retry: 5000\n\n" + fleetChanged) {
		return
	}
	keepalive := time.NewTicker(12 * time.Second)
	defer keepalive.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-next:
			next = s.fleetChanges.watch()
			if !s.authenticated(r) || !send(fleetChanged) {
				return
			}
		case <-keepalive.C:
			if !s.authenticated(r) || !send(": keepalive\n\n") {
				return
			}
		}
	}
}
