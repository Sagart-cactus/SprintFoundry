// Package runspec holds the run spec: how a candidate is built, how its
// preview is started, who the check runner can act as, and which paths a
// builder may not change without a person looking. The controller owns it and
// the builder can neither read nor write it. See docs/design/0001-run-spec.md.
package runspec

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"

	"go.yaml.in/yaml/v3"
)

// ErrInvalid is returned by Parse. Callers match it with errors.Is.
var ErrInvalid = errors.New("runspec: invalid run spec")

// Spec is a run spec.
type Spec struct {
	Version        int              `yaml:"version" json:"version"`
	Build          Build            `yaml:"build" json:"build"`
	Preview        Preview          `yaml:"preview" json:"preview"`
	Actors         map[string]Actor `yaml:"actors" json:"actors"`
	SensitivePaths []string         `yaml:"sensitive_paths" json:"sensitive_paths"`
}

// Build says how the image is built.
type Build struct {
	Dockerfile string `yaml:"dockerfile" json:"dockerfile"`
	Network    string `yaml:"network" json:"network"` // only "none" for now
	// BaseImages are the only images a Dockerfile may build FROM, each
	// pinned by digest. The controller pulls them itself; the builder's
	// Dockerfile never makes the runtime contact a registry of its choosing.
	BaseImages []string `yaml:"base_images" json:"base_images"`
}

// Preview says how the candidate is started for evaluation.
type Preview struct {
	Port   int               `yaml:"port" json:"port"`
	Env    map[string]string `yaml:"env,omitempty" json:"env,omitempty"`
	Health Health            `yaml:"health" json:"health"`
}

// Health says when the preview is ready.
type Health struct {
	Path   string `yaml:"path" json:"path"`
	Status int    `yaml:"status" json:"status"`
}

// Actor is how the check runner makes requests as one named user. The
// headers come from the project's test fixtures, never from production.
type Actor struct {
	Headers map[string]string `yaml:"headers" json:"headers"`
}

var (
	actorName   = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)
	pinnedImage = regexp.MustCompile(`^[a-zA-Z0-9][^@\s]*@sha256:[0-9a-f]{64}$`)
)

// Parse reads and validates a run spec. Unknown fields are errors.
func Parse(data []byte) (Spec, error) {
	var s Spec
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	if err := dec.Decode(&s); err != nil {
		return Spec{}, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	if err := s.validate(); err != nil {
		return Spec{}, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	return s, nil
}

func (s Spec) validate() error {
	if s.Version != 1 {
		return fmt.Errorf("version %d is not supported", s.Version)
	}
	d := s.Build.Dockerfile
	if d == "" || path.IsAbs(d) || strings.HasPrefix(d, "-") || path.Clean(d) != d || strings.HasPrefix(d, "..") {
		return fmt.Errorf("build.dockerfile %q must be a clean relative path", d)
	}
	if s.Build.Network != "none" {
		return fmt.Errorf("build.network %q is not supported; use \"none\"", s.Build.Network)
	}
	for _, image := range s.Build.BaseImages {
		if !pinnedImage.MatchString(image) {
			return fmt.Errorf("build.base_images: %q must be pinned as name@sha256:<64 hex>", image)
		}
	}
	if s.Preview.Port < 1 || s.Preview.Port > 65535 {
		return fmt.Errorf("preview.port %d is not a port", s.Preview.Port)
	}
	if !strings.HasPrefix(s.Preview.Health.Path, "/") || s.Preview.Health.Status < 100 || s.Preview.Health.Status > 599 {
		return errors.New("preview.health needs a path and an HTTP status")
	}
	if len(s.Actors) == 0 {
		return errors.New("at least one actor is required")
	}
	for name := range s.Actors {
		if !actorName.MatchString(name) {
			return fmt.Errorf("actor %q is not a valid name", name)
		}
	}
	if len(s.SensitivePaths) == 0 {
		return errors.New("sensitive_paths must list at least the Dockerfile")
	}
	for _, pattern := range s.SensitivePaths {
		if _, err := path.Match(pattern, "x"); err != nil {
			return fmt.Errorf("sensitive path pattern %q is not valid", pattern)
		}
	}
	if len(s.Sensitive([]string{s.Build.Dockerfile})) == 0 {
		return errors.New("sensitive_paths must cover build.dockerfile")
	}
	return nil
}

// Digest is the SHA-256 of the spec's canonical JSON form.
func (s Spec) Digest() string {
	canonical, err := json.Marshal(s)
	if err != nil {
		panic(fmt.Sprintf("runspec: spec cannot be encoded: %v", err))
	}
	sum := sha256.Sum256(canonical)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// Sensitive returns the changed paths that match a sensitive pattern. A
// pattern without a slash matches a file name in any directory; a pattern
// with a slash matches the whole path.
func (s Spec) Sensitive(changed []string) []string {
	var hits []string
	for _, p := range changed {
		for _, pattern := range s.SensitivePaths {
			target := p
			if !strings.Contains(pattern, "/") {
				target = path.Base(p)
			}
			if ok, _ := path.Match(pattern, target); ok {
				hits = append(hits, p)
				break
			}
		}
	}
	sort.Strings(hits)
	return hits
}
