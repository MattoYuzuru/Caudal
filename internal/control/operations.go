package control

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/MattoYuzuru/Caudal/internal/fleet"
	"github.com/MattoYuzuru/Caudal/internal/operations"
)

const (
	maxRunOperations = 4
	maxStoredRuns    = 128
	runLifetime      = 30 * time.Minute
	runTimeout       = 7 * time.Second
)

var (
	errRunMissing  = errors.New("run not found")
	errRunSession  = errors.New("run session expired")
	errRunFull     = errors.New("run capacity reached")
	errRunBusy     = errors.New("run is in progress")
	errInvalidPlan = errors.New("invalid operation plan")
)

type OperationRunner interface {
	List() []operations.Spec
	Execute(context.Context, string) operations.Result
}

type operation struct {
	spec    operations.Spec
	execute func(context.Context) operations.Result
}

type operationRun struct {
	ID         string              `json:"id"`
	Status     string              `json:"status"`
	Operations []operations.Spec   `json:"operations"`
	Results    []operations.Result `json:"results,omitempty"`
}

type runRecord struct {
	owner    [sha256.Size]byte
	expires  time.Time
	run      operationRun
	selected []operation
}

type runBook struct {
	mu      sync.Mutex
	records map[string]*runRecord
	slots   chan struct{}
}

func (s *Server) catalog(nodes []fleet.Node, scoped bool) []operation {
	var result []operation
	for _, node := range nodes {
		spec := operations.Spec{
			ID: "fleet-" + node.ID, Label: "Сводка по последнему heartbeat",
			Transport: "fleet", Target: node.Name, Effect: "read",
		}
		result = append(result, operation{spec: spec, execute: func(context.Context) operations.Result {
			current, err := s.fleet.Node(node.ID)
			if err != nil || current.Metrics == nil || current.LastSeen == nil {
				return operations.Result{Status: "failed", Lines: []string{"У узла пока нет замера."}}
			}
			return operations.Result{Status: "ok", Lines: []string{
				fmt.Sprintf("Heartbeat %s · %s", current.LastSeen.Format(time.RFC3339), current.Status),
				fmt.Sprintf("CPU %.1f%% · свободная RAM %.2f ГиБ · свободный диск %.2f ГиБ",
					current.Metrics.CPUPercent, gib(freeMemory(&current)), gib(freeDisk(&current))),
				fmt.Sprintf("Uptime %d с", current.Metrics.UptimeSeconds),
			}}
		}})
	}
	if s.config.Teleport != nil && !scoped {
		for _, profile := range s.config.Teleport.List() {
			spec := operations.Spec{
				ID: "teleport-" + profile.ID, Label: "Проверить веб-прокси Teleport",
				Transport: "teleport", Target: profile.Label, Method: "GET", Effect: "read",
			}
			result = append(result, operation{spec: spec, execute: func(ctx context.Context) operations.Result {
				checked, err := s.config.Teleport.Check(ctx, profile.ID)
				if err != nil {
					return operations.Result{Status: "failed", Lines: []string{"Проверка прокси прервалась."}}
				}
				if checked.Error != "" {
					return operations.Result{Status: "failed", Lines: []string{"HTTPS: " + checked.Error}}
				}
				return operations.Result{Status: "ok", Lines: []string{
					fmt.Sprintf("HTTPS /webapi/ping · %d мс · Teleport %s", checked.LatencyMS, checked.Version),
				}}
			}})
		}
	}
	if runner := s.config.Operations; runner != nil {
		for _, spec := range runner.List() {
			if scoped && (len(nodes) == 0 || spec.NodeID != nodes[0].ID) {
				continue
			}
			result = append(result, operation{spec: spec, execute: func(ctx context.Context) operations.Result {
				return runner.Execute(ctx, spec.ID)
			}})
		}
	}
	return result
}

func operationSpecs(items []operation) []operations.Spec {
	specs := make([]operations.Spec, 0, len(items))
	for _, item := range items {
		specs = append(specs, item.spec)
	}
	return specs
}

func providerTarget(spec operations.Spec) string {
	if spec.Transport == "http" {
		origin, err := url.Parse(spec.Target)
		if err == nil && origin.Host != "" {
			return origin.Scheme + "://" + origin.Host
		}
		return "HTTPS"
	}
	return spec.Target
}

func (s *Server) operationCatalog(w http.ResponseWriter, _ *http.Request) {
	respond(w, http.StatusOK, struct {
		Operations []operations.Spec `json:"operations"`
	}{operationSpecs(s.catalog(s.fleet.List(), false))})
}

func (s *Server) runOwner(r *http.Request) [sha256.Size]byte {
	cookie, _ := r.Cookie(s.cookieName()) // handlers run behind the owner session guard
	return sha256.Sum256([]byte(cookie.Value))
}

func (s *Server) proposeRun(r *http.Request, available []operation, ids []string, autoRead bool) (*operationRun, error) {
	if len(ids) == 0 || len(ids) > maxRunOperations {
		return nil, errInvalidPlan
	}
	selected := make([]operation, 0, len(ids))
	seen := make(map[string]bool, len(ids))
	readOnly := true
	for _, id := range ids {
		var match operation
		for _, candidate := range available {
			if candidate.spec.ID == id {
				match = candidate
				break
			}
		}
		if match.execute == nil || seen[id] {
			return nil, errInvalidPlan
		}
		seen[id] = true
		selected = append(selected, match)
		readOnly = readOnly && match.spec.Effect == "read"
	}
	if err := r.Context().Err(); err != nil {
		return nil, err
	}
	if !s.authenticated(r) {
		return nil, errRunSession
	}
	var nonce [16]byte
	rand.Read(nonce[:])
	id := hex.EncodeToString(nonce[:])
	now := time.Now()
	owner := s.runOwner(r)
	s.runs.mu.Lock()
	for key, record := range s.runs.records {
		if now.After(record.expires) {
			delete(s.runs.records, key)
		}
	}
	if len(s.runs.records) >= maxStoredRuns {
		s.runs.mu.Unlock()
		return nil, errRunFull
	}
	plan := operationRun{ID: id, Status: "awaiting_approval", Operations: operationSpecs(selected)}
	s.runs.records[id] = &runRecord{owner: owner, expires: now.Add(runLifetime), run: plan, selected: selected}
	s.runs.mu.Unlock()

	s.config.Logger.Info("Caudal run proposed", "id", id, "operations", ids)
	if autoRead && readOnly {
		done, err := s.executeRun(r, id, "auto_read")
		if err == nil {
			return &done, nil
		}
		if !errors.Is(err, errRunFull) {
			return nil, err
		}
	}
	return &plan, nil
}

func (s *Server) findRunLocked(id string, owner [sha256.Size]byte) (*runRecord, error) {
	record := s.runs.records[id]
	if record == nil || record.owner != owner || time.Now().After(record.expires) {
		return nil, errRunMissing
	}
	return record, nil
}

func (s *Server) executeRun(r *http.Request, id, approval string) (operationRun, error) {
	ctx := r.Context()
	if err := ctx.Err(); err != nil {
		return operationRun{}, err
	}
	cookie, err := r.Cookie(s.cookieName())
	if err != nil {
		return operationRun{}, errRunSession
	}
	s.authMu.Lock()
	if !time.Now().Before(s.sessions[cookie.Value]) {
		s.authMu.Unlock()
		return operationRun{}, errRunSession
	}
	// Take the run lock before releasing the session lock to accept this dispatch
	// while the approving session is still live.
	s.runs.mu.Lock()
	s.authMu.Unlock()
	record, err := s.findRunLocked(id, sha256.Sum256([]byte(cookie.Value)))
	if err != nil {
		s.runs.mu.Unlock()
		return operationRun{}, err
	}
	switch record.run.Status {
	case "running":
		s.runs.mu.Unlock()
		return operationRun{}, errRunBusy
	case "completed", "cancelled":
		run := record.run
		s.runs.mu.Unlock()
		return run, nil
	}
	readOnly := true
	for _, item := range record.selected {
		readOnly = readOnly && item.spec.Effect == "read"
	}
	if approval == "auto_read" && !readOnly {
		s.runs.mu.Unlock()
		return operationRun{}, errInvalidPlan
	}
	select {
	case s.runs.slots <- struct{}{}:
		defer func() { <-s.runs.slots }()
	default:
		s.runs.mu.Unlock()
		return operationRun{}, errRunFull
	}
	record.run.Status = "running"
	s.runs.mu.Unlock()

	s.config.Logger.Info("Caudal run approved", "id", id, "approval", approval)
	ctx, cancel := context.WithTimeout(ctx, runTimeout)
	defer cancel()
	results := make([]operations.Result, len(record.selected))
	execute := func(i int, item operation) {
		started := time.Now()
		result := item.execute(ctx)
		result.OperationID = item.spec.ID
		result.DurationMS = time.Since(started).Milliseconds()
		results[i] = result
	}
	if readOnly {
		var group sync.WaitGroup
		for i, item := range record.selected {
			group.Go(func() { execute(i, item) })
		}
		group.Wait()
	} else {
		for i, item := range record.selected {
			if ctx.Err() != nil || (i > 0 && results[i-1].Status != "ok") {
				results[i] = operations.Result{
					OperationID: item.spec.ID, Status: "failed",
					Lines: []string{"Шаг пропущен из-за предыдущего результата или тайм-аута."},
				}
				continue
			}
			execute(i, item)
		}
	}
	s.runs.mu.Lock()
	record.run.Status, record.run.Results = "completed", results
	run := record.run
	s.runs.mu.Unlock()
	s.config.Logger.Info("Caudal run completed", "id", id)
	return run, nil
}

func (s *Server) approveRun(w http.ResponseWriter, r *http.Request) {
	run, err := s.executeRun(r, r.PathValue("id"), "owner")
	s.respondRun(w, run, err)
}

func (s *Server) getRun(w http.ResponseWriter, r *http.Request) {
	s.runs.mu.Lock()
	record, err := s.findRunLocked(r.PathValue("id"), s.runOwner(r))
	var run operationRun
	if err == nil {
		if record.run.Status == "running" {
			err = errRunBusy
		} else {
			run = record.run
		}
	}
	s.runs.mu.Unlock()
	s.respondRun(w, run, err)
}

func (s *Server) cancelRun(w http.ResponseWriter, r *http.Request) {
	s.runs.mu.Lock()
	record, err := s.findRunLocked(r.PathValue("id"), s.runOwner(r))
	if err != nil {
		s.runs.mu.Unlock()
		s.respondRun(w, operationRun{}, err)
		return
	}
	if record.run.Status == "running" {
		s.runs.mu.Unlock()
		s.respondRun(w, operationRun{}, errRunBusy)
		return
	}
	cancelled := record.run.Status == "awaiting_approval"
	if cancelled {
		record.run.Status = "cancelled"
	}
	run := record.run
	s.runs.mu.Unlock()
	if cancelled {
		s.config.Logger.Info("Caudal run cancelled", "id", run.ID)
	}
	s.respondRun(w, run, nil)
}

func (s *Server) respondRun(w http.ResponseWriter, run operationRun, err error) {
	switch {
	case errors.Is(err, errRunSession):
		failure(w, http.StatusUnauthorized, "authentication_required")
	case errors.Is(err, errRunMissing):
		failure(w, http.StatusNotFound, "operation_run_not_found")
	case errors.Is(err, errRunBusy):
		failure(w, http.StatusConflict, "operation_in_progress")
	case errors.Is(err, errRunFull):
		failure(w, http.StatusTooManyRequests, "operation_busy")
	case errors.Is(err, errInvalidPlan):
		failure(w, http.StatusUnprocessableEntity, "invalid_operation_plan")
	case err != nil:
		failure(w, http.StatusServiceUnavailable, "operation_unavailable")
	default:
		respond(w, http.StatusOK, struct {
			Run operationRun `json:"run"`
		}{run})
	}
}

func (s *Server) receipt(r *http.Request, id string) ([]string, error) {
	s.runs.mu.Lock()
	defer s.runs.mu.Unlock()
	record, err := s.findRunLocked(id, s.runOwner(r))
	if err != nil {
		return nil, err
	}
	if record.run.Status != "completed" {
		return nil, errRunBusy
	}
	var receipt []string
	for i, result := range record.run.Results {
		spec := record.run.Operations[i]
		for _, line := range result.Lines {
			anchor := fmt.Sprintf("#run-%s-L%d", id, len(receipt)+1)
			receipt = append(receipt, fmt.Sprintf("%s · %s · %s · %s", anchor, providerTarget(spec), result.Status, line))
		}
	}
	return receipt, nil
}
