package main

import (
	"context"
	"errors"
	"io"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/MattoYuzuru/Caudal/internal/collector"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx); err != nil {
		log.Fatal(err)
	}
}

func run(ctx context.Context) error {
	interval, err := parseInterval(os.Getenv("CAUDAL_INTERVAL"))
	if err != nil {
		return err
	}
	token, err := readToken(os.Getenv("CAUDAL_TOKEN"), os.Getenv("CAUDAL_TOKEN_FILE"))
	if err != nil {
		return err
	}
	client, err := collector.NewClient(os.Getenv("CAUDAL_URL"), token)
	if err != nil {
		return err
	}
	sampler, err := collector.NewSampler()
	if err != nil {
		return err
	}

	var sent bool
	var lastError string
	for ctx.Err() == nil {
		metrics, err := sampler.Read(ctx)
		if err == nil {
			err = client.Send(ctx, metrics)
		}
		if ctx.Err() != nil {
			break
		}
		if err != nil {
			if lastError != err.Error() {
				log.Print(err)
				lastError = err.Error()
			}
		} else if !sent || lastError != "" {
			log.Print("heartbeat accepted by Caudal")
			sent = true
			lastError = ""
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
		case <-timer.C:
		}
	}
	return nil
}

func parseInterval(raw string) (time.Duration, error) {
	if raw == "" {
		return 30 * time.Second, nil
	}
	interval, err := time.ParseDuration(raw)
	if err != nil || interval < 5*time.Second || interval > time.Minute {
		return 0, errors.New("CAUDAL_INTERVAL must be between 5s and 1m")
	}
	return interval, nil
}

func readToken(token, path string) (string, error) {
	if path == "" {
		return strings.TrimSpace(token), nil
	}
	if token != "" {
		return "", errors.New("set one of CAUDAL_TOKEN or CAUDAL_TOKEN_FILE")
	}
	file, err := os.Open(path)
	if err != nil {
		return "", errors.New("cannot open CAUDAL_TOKEN_FILE")
	}
	defer file.Close()
	info, err := file.Stat()
	forbidden := os.FileMode(0077)
	if directory := os.Getenv("CREDENTIALS_DIRECTORY"); directory != "" && path == filepath.Join(directory, "agent-token") {
		// systemd can expose private credentials using a per-service ACL and mode 0440.
		forbidden = 0037
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&forbidden != 0 {
		return "", errors.New("CAUDAL_TOKEN_FILE must be a private regular file")
	}
	const maxTokenBytes = 4096
	contents, err := io.ReadAll(io.LimitReader(file, maxTokenBytes+1))
	if err != nil || len(contents) > maxTokenBytes {
		return "", errors.New("cannot read CAUDAL_TOKEN_FILE")
	}
	return strings.TrimSpace(string(contents)), nil
}
