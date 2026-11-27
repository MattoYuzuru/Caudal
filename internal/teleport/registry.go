package teleport

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	maxProfiles = 8
	cooldown    = 10 * time.Second
)

var ErrUnknown = errors.New("unknown Teleport profile")

const (
	NotChecked  = "not_checked"
	Reachable   = "reachable"
	Unreachable = "unreachable"
)

type Profile struct {
	ID        string    `json:"id"`
	Label     string    `json:"label"`
	WebURL    string    `json:"web_url"`
	Status    string    `json:"status"`
	CheckedAt time.Time `json:"checked_at,omitzero"`
	LatencyMS int64     `json:"latency_ms,omitempty"`
	Error     string    `json:"error,omitempty"`
	Version   string    `json:"version,omitempty"`
}

type profileConfig struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	WebURL string `json:"web_url"`
}

type entry struct {
	profile  Profile
	inFlight chan struct{}
}

// Registry checks only the Teleport web origins configured by the Caudal operator.
type Registry struct {
	mu      sync.Mutex
	entries map[string]*entry
	order   []string
	probe   func(context.Context, string) (version, reason string)
}

var (
	idPattern   = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,47}$`)
	hostPattern = regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
)

func New(raw string) (*Registry, error) {
	registry := &Registry{entries: make(map[string]*entry), probe: newProbe()}
	if raw = strings.TrimSpace(raw); raw == "" {
		return registry, nil
	}
	if len(raw) > 8<<10 {
		return nil, errors.New("Teleport profile configuration exceeds 8 KiB")
	}
	var profiles []profileConfig
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&profiles); err != nil || profiles == nil || decoder.Decode(new(any)) != io.EOF {
		return nil, errors.New("Teleport profiles must be a JSON array of id, label and web_url objects")
	}
	if len(profiles) > maxProfiles {
		return nil, errors.New("configure at most eight Teleport profiles")
	}
	for index, config := range profiles {
		label := strings.TrimSpace(config.Label)
		if !idPattern.MatchString(config.ID) || label == "" || utf8.RuneCountInString(label) > 64 || strings.ContainsFunc(label, unicode.IsControl) {
			return nil, fmt.Errorf("invalid ID or label in Teleport profile %d", index+1)
		}
		if _, duplicate := registry.entries[config.ID]; duplicate {
			return nil, fmt.Errorf("duplicate ID in Teleport profile %d", index+1)
		}
		origin, err := parseOrigin(config.WebURL)
		if err != nil {
			return nil, fmt.Errorf("invalid public HTTPS origin in Teleport profile %d", index+1)
		}
		registry.entries[config.ID] = &entry{profile: Profile{
			ID: config.ID, Label: label, WebURL: origin, Status: NotChecked,
		}}
		registry.order = append(registry.order, config.ID)
	}
	return registry, nil
}

func parseOrigin(raw string) (string, error) {
	invalid := errors.New("expected a public HTTPS origin")
	origin, err := url.Parse(raw)
	if err != nil || origin.Scheme != "https" || origin.Host == "" || origin.User != nil ||
		(origin.Path != "" && origin.Path != "/") || strings.ContainsAny(raw, "?#") {
		return "", invalid
	}
	host := strings.TrimSuffix(strings.ToLower(origin.Hostname()), ".")
	if addr, err := netip.ParseAddr(host); err == nil {
		if !publicAddress(addr) {
			return "", invalid
		}
		addr = addr.Unmap()
		host = addr.String()
		if addr.Is6() && origin.Port() == "" {
			host = "[" + host + "]"
		}
	} else if len(host) > 253 || !hostPattern.MatchString(host) || reservedDomain(host) {
		return "", invalid
	}
	if port := origin.Port(); port != "" {
		number, err := strconv.ParseUint(port, 10, 16)
		if err != nil || number == 0 {
			return "", invalid
		}
		host = net.JoinHostPort(host, strconv.FormatUint(number, 10))
	} else if strings.HasSuffix(origin.Host, ":") {
		return "", invalid
	}
	return (&url.URL{Scheme: "https", Host: host}).String(), nil
}

func reservedDomain(host string) bool {
	for _, suffix := range []string{".localhost", ".local", ".internal", ".home.arpa", ".test", ".invalid", ".onion"} {
		if strings.HasSuffix(host, suffix) {
			return true
		}
	}
	return false
}

func (r *Registry) List() []Profile {
	r.mu.Lock()
	defer r.mu.Unlock()
	profiles := make([]Profile, 0, len(r.order))
	for _, id := range r.order {
		profiles = append(profiles, r.entries[id].profile)
	}
	return profiles
}

func (r *Registry) Check(ctx context.Context, id string) (Profile, error) {
	for {
		if err := ctx.Err(); err != nil {
			return Profile{}, err
		}
		r.mu.Lock()
		item, exists := r.entries[id]
		if !exists {
			r.mu.Unlock()
			return Profile{}, ErrUnknown
		}
		profile := item.profile
		if time.Since(profile.CheckedAt) < cooldown {
			r.mu.Unlock()
			return profile, nil
		}
		if active := item.inFlight; active != nil {
			r.mu.Unlock()
			select {
			case <-ctx.Done():
				return Profile{}, ctx.Err()
			case <-active:
				continue
			}
		}
		item.inFlight = make(chan struct{})
		r.mu.Unlock()

		started := time.Now()
		profile.Version, profile.Error = r.probe(ctx, profile.WebURL)
		profile.CheckedAt = time.Now()
		profile.LatencyMS = profile.CheckedAt.Sub(started).Milliseconds()
		profile.Status = Reachable
		if profile.Error != "" {
			profile.Status = Unreachable
		}

		r.mu.Lock()
		err := ctx.Err()
		if err == nil {
			item.profile = profile
		}
		close(item.inFlight)
		item.inFlight = nil
		r.mu.Unlock()
		if err != nil {
			return Profile{}, err
		}
		return profile, nil
	}
}
